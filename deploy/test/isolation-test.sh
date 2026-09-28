#!/usr/bin/env bash
# =====================================================================================================
# Répétition LOCALE de l'isolement (docs/VPS_ISOLATION.md, moitié A) — aucun accès au VPS.
# Un conteneur Debian trixie avec systemd comme PID 1 joue le rôle du VPS :
#   1. utilisateur système delaipay-staging, arborescence /srv/delaipay-staging (0700), secrets root:root 0600,
#      règle sudoers unique, unités systemd durcies — exactement les commandes du runbook ;
#   2. le service démarre et répond (/healthz, base écrite dans shared/data) ; la sauvegarde chiffrée tourne ;
#   3. un compte ordinaire (« khalil » SANS sudo ni docker) et un compte d'agent ne lisent RIEN ;
#      le compte de déploiement ne lit pas les secrets et ne peut rien faire d'autre avec sudo ;
#   4. une sonde lancée avec le même bac à sable que le service prouve : /home invisible, versions en lecture seule,
#      /etc non inscriptible, clé SSH de déploiement inaccessible, aucune sortie réseau, aucun privilège ;
#   5. systemd-analyze security sur les unités réellement chargées.
# Usage : deploy/test/isolation-test.sh      (Docker requis ; réseau requis pour Debian, Node.js et npm ci)
# =====================================================================================================
set -Eeuo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/dp-isolation}"
IMG=delaipay-isolation-test:trixie
NAME=dp-isolation
rm -rf "$WORK"; mkdir -p "$WORK/ctx"

# ---- image : Debian trixie + systemd + sudo + gpg + Node.js 24 (binaire officiel)
cat > "$WORK/ctx/Dockerfile" <<'EOF'
FROM debian:trixie-slim
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      systemd systemd-sysv sudo gnupg curl ca-certificates xz-utils procps acl iproute2 >/dev/null && rm -rf /var/lib/apt/lists/*
RUN set -e; A="$(dpkg --print-architecture)"; [ "$A" = amd64 ] && A=x64; \
    F="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk -v a="linux-$A.tar.xz" '$2 ~ a {print $2}')"; \
    curl -fsSL "https://nodejs.org/dist/latest-v24.x/$F" | tar -xJ -C /usr/local --strip-components=1; \
    ln -sf /usr/local/bin/node /usr/bin/node; ln -sf /usr/local/bin/npm /usr/bin/npm; node --version
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
EOF
docker build -q -t "$IMG" "$WORK/ctx" >/dev/null

# ---- code : arbre de travail (fichiers suivis + nouveaux non ignorés), sans données ni dépendances
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
allowed() { if "${@:2}" >/dev/null 2>&1; then ok "$1"; else ko "$1 — refusé"; fi; }

step "A1. Utilisateur système delaipay-staging (runbook §A1)"
useradd --system --user-group --home-dir /srv/delaipay-staging --no-create-home --shell /bin/bash delaipay-staging
passwd -l delaipay-staging >/dev/null
id delaipay-staging | grep -Eq 'groups=[0-9]+\(delaipay-staging\)$' && ok "aucun groupe supplémentaire (ni sudo ni docker)" || ko "groupes : $(id delaipay-staging)"
passwd -S delaipay-staging | awk '{print $2}' | grep -q '^L' && ok "mot de passe verrouillé" || ko "mot de passe non verrouillé"

step "A2. Arborescence /srv/delaipay-staging (0700)"
install -d -o root -g root -m 0755 /srv
install -d -o delaipay-staging -g delaipay-staging -m 0700 /srv/delaipay-staging
for d in releases shared shared/data shared/uploads backups pre-deploy .ssh .gnupg; do
  install -d -o delaipay-staging -g delaipay-staging -m 0700 "/srv/delaipay-staging/$d"; done
ok "$(stat -c '%U:%G %a' /srv/delaipay-staging) /srv/delaipay-staging"

step "A3. Secrets : /etc/delaipay-staging/staging.env root:root 0600"
install -d -o root -g root -m 0700 /etc/delaipay-staging
mkdir -p /root/src && tar -xf /root/src.tar -C /root/src
sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')|" \
    -e "s|^PLATFORM_SECRET_KEY=.*|PLATFORM_SECRET_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')|" \
    -e "s|^TENANT_BASE_DOMAINS=.*|TENANT_BASE_DOMAINS=staging.localhost|" \
    -e "s|^BACKUP_AGE_RECIPIENT=.*|BACKUP_GPG_RECIPIENT=backup@delaipay.test|" \
    /root/src/deploy/staging.env.example > /etc/delaipay-staging/staging.env
chown root:root /etc/delaipay-staging/staging.env; chmod 0600 /etc/delaipay-staging/staging.env
ok "$(stat -c '%U:%G %a' /etc/delaipay-staging/staging.env) staging.env"

step "A4. Version déployée (comme deploy.sh : releases/<id>, lien current, npm ci par delaipay-staging)"
R=/srv/delaipay-staging/releases/test-0000000
install -d -o delaipay-staging -g delaipay-staging -m 0700 "$R"
cp -a /root/src/app "$R/app"; echo 0000000 > "$R/REVISION"; chown -R delaipay-staging:delaipay-staging "$R"
sudo -u delaipay-staging -H bash -c "cd $R/app && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1" && ok "npm ci (delaipay-staging)" || ko "npm ci"
sudo -u delaipay-staging ln -sfn "$R" /srv/delaipay-staging/current
install -o delaipay-staging -g delaipay-staging -m 0600 /root/src/deploy/deploy.conf.example /srv/delaipay-staging/deploy.conf

step "A5. Unités systemd durcies + règle sudoers unique"
install -m 0644 /root/src/deploy/systemd/delaipay-staging.service /root/src/deploy/systemd/delaipay-staging-backup.service \
  /root/src/deploy/systemd/delaipay-staging-backup.timer /etc/systemd/system/
systemctl daemon-reload
V="$(systemd-analyze verify /etc/systemd/system/delaipay-staging.service /etc/systemd/system/delaipay-staging-backup.service 2>&1 || true)"
[ -z "$V" ] && ok "systemd-analyze verify : aucune remarque" || ko "verify : $V"
printf 'delaipay-staging ALL=(root) NOPASSWD: /usr/bin/systemctl restart delaipay-staging.service\n' > /etc/sudoers.d/delaipay-staging
chmod 0440 /etc/sudoers.d/delaipay-staging
visudo -cf /etc/sudoers.d/delaipay-staging >/dev/null && ok "visudo -c" || ko "visudo"
systemctl enable --now delaipay-staging.service >/dev/null 2>&1
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:4200/healthz 2>/dev/null | grep -q '"ok":true' && break; sleep 1; done
H="$(curl -fsS http://127.0.0.1:4200/healthz 2>/dev/null || true)"
grep -q '"db":"ok"' <<<"$H" && ok "service démarré sous le bac à sable, /healthz : $H" || { ko "santé : $H"; journalctl -u delaipay-staging --no-pager | tail -20; }
[ -f /srv/delaipay-staging/shared/data/delaipay.db ] && ok "base créée dans shared/data ($(stat -c '%U %a' /srv/delaipay-staging/shared/data/delaipay.db))" || ko "base absente"
P="$(systemctl show -p MainPID --value delaipay-staging)"
grep -Eq '^NoNewPrivs:\s+1' /proc/$P/status && ok "NoNewPrivs=1" || ko "NoNewPrivs"
grep -Eq '^CapEff:\s+0+$' /proc/$P/status && grep -Eq '^CapBnd:\s+0+$' /proc/$P/status && ok "aucune capacité (effective et limite)" || ko "capacités : $(grep Cap /proc/$P/status | tr '\n' ' ')"
grep -Eq '^Seccomp:\s+2' /proc/$P/status && ok "filtre d'appels système actif (seccomp)" || ko "seccomp"
ss -ltnp 2>/dev/null | grep ':4200' | grep -q '127.0.0.1:4200' && ok "écoute sur 127.0.0.1:4200 uniquement" || ko "écoute : $(ss -ltn | grep 4200)"

step "A6. Déploiement : redémarrage par la règle sudoers, et RIEN d'autre"
allowed "delaipay-staging : sudo -n systemctl restart delaipay-staging.service" sudo -u delaipay-staging sudo -n /usr/bin/systemctl restart delaipay-staging.service
denied  "delaipay-staging : sudo -n systemctl stop delaipay-staging.service" sudo -u delaipay-staging sudo -n /usr/bin/systemctl stop delaipay-staging.service
denied  "delaipay-staging : sudo -n systemctl edit delaipay-staging.service" sudo -u delaipay-staging sudo -n /usr/bin/systemctl edit delaipay-staging.service
denied  "delaipay-staging : sudo -n systemctl restart ssh.service" sudo -u delaipay-staging sudo -n /usr/bin/systemctl restart ssh.service
denied  "delaipay-staging : sudo -n cat /etc/shadow" sudo -u delaipay-staging sudo -n cat /etc/shadow
denied  "delaipay-staging : lire staging.env (secrets)" sudo -u delaipay-staging cat /etc/delaipay-staging/staging.env
denied  "delaipay-staging : modifier l'unité systemd" sudo -u delaipay-staging bash -c 'echo x >> /etc/systemd/system/delaipay-staging.service'
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:4200/healthz 2>/dev/null | grep -q '"ok":true' && break; sleep 1; done

step "A7. Sauvegarde chiffrée sous le même bac à sable (clé PUBLIQUE seule dans /srv/delaipay-staging/.gnupg)"
G=/root/gpg-offline; install -d -m 700 "$G"
gpg --homedir "$G" --batch --passphrase '' --quick-gen-key 'Sauvegarde (test) <backup@delaipay.test>' default default 1d >/dev/null 2>&1
gpg --homedir "$G" --armor --export backup@delaipay.test > /tmp/pub.asc; chmod 644 /tmp/pub.asc
sudo -u delaipay-staging -H gpg --batch --import /tmp/pub.asc >/dev/null 2>&1 && ok "clé publique importée par delaipay-staging" || ko "import de la clé publique"
systemctl start delaipay-staging-backup.service
F="$(ls /srv/delaipay-staging/backups/*.gpg 2>/dev/null | head -1)"
[ -n "$F" ] && ok "sauvegarde : $(basename "$F") ($(stat -c '%U %a' "$F"))" || { ko "sauvegarde absente"; journalctl -u delaipay-staging-backup --no-pager | tail -15; }
[ -n "$F" ] && gpg --homedir "$G" --batch --pinentry-mode loopback --passphrase "" --decrypt "$F" 2>/dev/null | tar -tz 2>/dev/null | grep -c "delaipay.db" | grep -q "^[1-9]" && ok "déchiffrable par la clé privée hors ligne" || ko "déchiffrement"

step "A8. Autres comptes : khalil (sans sudo ni docker) et un compte d'agent"
useradd -m -s /bin/bash khalil; useradd -m -s /bin/bash openclaw
echo secret-khalil > /home/khalil/note; chmod 700 /home/khalil
for u in khalil openclaw; do
  denied "$u : lister /srv/delaipay-staging" sudo -u "$u" ls /srv/delaipay-staging
  denied "$u : lire la base" sudo -u "$u" cat /srv/delaipay-staging/shared/data/delaipay.db
  denied "$u : lire une sauvegarde" sudo -u "$u" cat "$F"
  denied "$u : lire staging.env" sudo -u "$u" cat /etc/delaipay-staging/staging.env
  denied "$u : écrire dans releases/" sudo -u "$u" touch /srv/delaipay-staging/current/app/x
  denied "$u : redémarrer le service" sudo -u "$u" sudo -n /usr/bin/systemctl restart delaipay-staging.service
done
denied "delaipay-staging : lire /home/khalil" sudo -u delaipay-staging cat /home/khalil/note

step "A9. Sonde avec le bac à sable EXACT du service (unité copiée, seule la commande change)"
sed -e 's|^Type=simple|Type=oneshot|' -e 's|^ExecStart=.*|ExecStart=/bin/bash /srv/delaipay-staging/shared/probe.sh|' \
    -e '/^Restart=/d' -e '/^\[Install\]/,$d' /etc/systemd/system/delaipay-staging.service > /etc/systemd/system/dp-probe.service
cat > /srv/delaipay-staging/shared/probe.sh <<'EOF'
t() { if eval "$2" >/dev/null 2>&1; then echo "OUVERT  $1"; else echo "fermé   $1"; fi; }
t "/home visible"                 "ls /home/khalil"
t "écrire dans current/"          "touch /srv/delaipay-staging/current/app/x"
t "écrire dans /etc"              "touch /etc/x"
t "lire .ssh (clé de déploiement)" "ls /srv/delaipay-staging/.ssh"
t "lire repo.git"                 "ls /srv/delaipay-staging/repo.git"
t "lire backups/"                 "ls /srv/delaipay-staging/backups"
t "lire staging.env"              "cat /etc/delaipay-staging/staging.env"
t "réseau sortant (1.1.1.1:443)"  "timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'"
t "processus de root (PID 1)"     "cat /proc/1/cmdline"
t "écrire dans shared/data"       "touch /srv/delaipay-staging/shared/data/.probe && rm /srv/delaipay-staging/shared/data/.probe"
EOF
chown delaipay-staging: /srv/delaipay-staging/shared/probe.sh
systemctl daemon-reload; systemctl start dp-probe.service
OUT="$(journalctl -u dp-probe --no-pager -o cat | grep -E '^(OUVERT|fermé)')"
while IFS= read -r l; do
  case "$l" in
    *"écrire dans shared/data"*) [[ "$l" == OUVERT* ]] && ok "service : $l (seul répertoire inscriptible)" || ko "service : $l";;
    OUVERT*) ko "service : $l";;
    *) ok "service : $l";;
  esac
done <<<"$OUT"
[ -n "$OUT" ] || ko "sonde sans sortie : $(journalctl -u dp-probe --no-pager | tail -5)"
rm -f /etc/systemd/system/dp-probe.service /srv/delaipay-staging/shared/probe.sh; systemctl daemon-reload

step "A10. systemd-analyze security (unités chargées)"
for u in delaipay-staging.service delaipay-staging-backup.service; do
  S="$(systemd-analyze security "$u" 2>/dev/null | grep 'Overall exposure')"; ok "$u : ${S#*: }"; done

printf '\n%s\n' "$([ "$FAILS" = 0 ] && echo 'RÉPÉTITION DE L’ISOLEMENT : AUCUN ÉCHEC' || echo "RÉPÉTITION DE L’ISOLEMENT : $FAILS ÉCHEC(S)")"
exit "$FAILS"
INSIDE
