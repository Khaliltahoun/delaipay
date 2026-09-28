#!/usr/bin/env bash
# =====================================================================================================
# Répétition LOCALE du staging (aucun accès au VPS) : dépôt git local, répertoire cible local, nginx en conteneur.
#   1. deploy.sh d'un commit sain (tests complets, sauvegarde, migrations, santé)
#   2. seed fictif + vérification de la référence (36 · 16 · 350 964,42 · 7 025,33 · md5)
#   3. deploy.sh d'un commit CASSÉ (santé en échec) → retour arrière automatique prouvé
#   4. nginx (image officielle) devant l'application : *.staging.localhost + admin.staging.localhost, certificat joker
#      auto-signé, redirection HTTP → HTTPS, HSTS, taille maximale, X-Forwarded-For forgé ignoré, authentification basique.
#   5. sauvegarde chiffrée (gpg jetable) → restauration dans un répertoire neuf → référence identique.
# Usage : deploy/test/local-test.sh        (Docker requis pour l'étape 4)
# =====================================================================================================
set -Eeuo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/dp-staging-rehearsal}"
PORT="${PORT_APP:-4291}"
rm -rf "$WORK"; mkdir -p "$WORK"/{root,data,uploads,backups,logs}
cd "$WORK"
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
ko() { printf '  \033[31m✘\033[0m %s\n' "$*"; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "0. Dépôt source local (commit sain + commit volontairement cassé)"
git clone -q --bare "$REPO" origin.git
git clone -q origin.git work
( cd work && git checkout -q -b bad && printf "\nthrow new Error('démarrage volontairement cassé (test de retour arrière)');\n" >> app/src/server.js \
  && git -c user.email=t@t -c user.name=test commit -qam "test: version cassée" && git push -q origin bad )
GOOD="$(git --git-dir=origin.git rev-parse HEAD)"; BAD="$(git --git-dir=origin.git rev-parse bad)"
ok "sain ${GOOD:0:7} · cassé ${BAD:0:7}"

cat > staging.env <<EOF
NODE_ENV=production
DELAIPAY_ENV=staging
PORT=$PORT
HOST=0.0.0.0
DELAIPAY_AUTO_SEED=0
TRUST_PROXY=loopback,uniquelocal
TENANT_BASE_DOMAINS=staging.localhost
COOKIE_SECURE=1
DB_PATH=$WORK/data/delaipay.db
UPLOADS_DIR=$WORK/uploads
JWT_SECRET=$(openssl rand -hex 48)
PLATFORM_SECRET_KEY=$(openssl rand -hex 32)
BACKUP_DIR=$WORK/backups
BACKUP_STATUS_FILE=$WORK/data/backup-status.json
BACKUP_PREFIX=delaipay-staging
EOF
chmod 600 staging.env
# Redémarrage local (remplace systemctl) : arrête l'instance précédente, lance « current ».
cat > restart.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
W="$(cd "$(dirname "$0")" && pwd)"
[ -f "$W/app.pid" ] && kill "$(cat "$W/app.pid")" 2>/dev/null || true; sleep 1
( set -a; . "$W/staging.env"; set +a; cd "$W/root/current/app"; nohup node src/server.js >>"$W/logs/app.log" 2>&1 & echo $! > "$W/app.pid" )
EOF
chmod +x restart.sh
export DEPLOY_ROOT="$WORK/root" REPO_URL="$WORK/origin.git" ENV_FILE="$WORK/staging.env" RESTART_CMD="$WORK/restart.sh" \
  HEALTH_URL="http://127.0.0.1:$PORT/healthz" HEALTH_TRIES=8 NPM_CI_CMD="cp -R '$REPO/app/node_modules' ."

step "1. Déploiement du commit sain (tests complets, sauvegarde, migrations, santé)"
"$REPO/deploy/deploy.sh" "$GOOD" | sed 's/^/    /'
curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -q "\"commit\":\"${GOOD:0:7}\"" && ok "santé : commit ${GOOD:0:7} en service" || ko "santé"

step "2. Données fictives du staging + référence"
( set -a; . ./staging.env; set +a; cd root/current/app && node src/ops/staging-seed.js | sed -E 's/ [A-Za-z0-9_-]{10,}-7a$/ ********/; s/^/    /' )
( set -a; . ./staging.env; set +a; cd root/current/app && node src/ops/verify-baseline.js --slug hlz-demo --expect "36,16,350964.42,7025.33,a7d1acaac0688170ef95fce6b7bb2082" | tail -1 | sed 's/^/    /' )
( set -a; . ./staging.env; set +a; cd root/current/app && PLATFORM_ADMIN_PASSWORD='Repetition-Staging-2026!' DP_PLATFORM_CLI_MODE=create node src/platform/cli.js --email ops@staging.test --nom "Répétition" | head -1 | sed 's/^/    /' )

step "3. Déploiement d'un commit CASSÉ → retour arrière automatique"
set +e; "$REPO/deploy/deploy.sh" bad | sed 's/^/    /'; RC=${PIPESTATUS[0]}; set -e
[ "$RC" = "2" ] && ok "deploy.sh a signalé l'échec (code 2)" || ko "code de sortie inattendu : $RC"
curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -q "\"commit\":\"${GOOD:0:7}\"" && ok "retour arrière : ${GOOD:0:7} de nouveau en service" || ko "retour arrière"
[ "$(readlink root/current)" != "" ] && basename "$(readlink root/current)" | grep -q "${GOOD:0:7}" && ok "lien current → version saine" || ko "lien current"
ls root/releases | grep -q "${BAD:0:7}.echec" && ok "version cassée conservée pour analyse (.echec)"
ls root/pre-deploy/*.db >/dev/null && ok "sauvegardes de pré-déploiement présentes : $(ls root/pre-deploy | wc -l | tr -d ' ')"

step "4. nginx devant l'application (conteneur nginx:1.27-alpine)"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  mkdir -p nginx/snippets nginx/certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=staging.localhost" \
    -addext "subjectAltName=DNS:*.staging.localhost,DNS:staging.localhost" -keyout nginx/certs/privkey.pem -out nginx/certs/fullchain.pem 2>/dev/null
  cp "$REPO"/deploy/nginx/snippets/*.conf nginx/snippets/
  sed -e 's/staging\.delaipay\.com/staging.localhost/g' -e "s#127.0.0.1:4200#host.docker.internal:$PORT#" \
      -e 's#/etc/letsencrypt/live/staging.localhost/#/etc/nginx/certs/#' -e 's#snippets/#/etc/nginx/snippets/#' \
      "$REPO/deploy/nginx/delaipay-staging.conf" > nginx/site.conf
  printf 'fondateur:%s\n' "$(openssl passwd -apr1 'Staging-Basic-2026')" > nginx/htpasswd
  docker rm -f dp-stg-nginx >/dev/null 2>&1 || true
  docker run -d --name dp-stg-nginx -p 18080:80 -p 18443:443 --add-host host.docker.internal:host-gateway \
    -v "$WORK/nginx/site.conf:/etc/nginx/conf.d/default.conf:ro" -v "$WORK/nginx/snippets:/etc/nginx/snippets:ro" \
    -v "$WORK/nginx/certs:/etc/nginx/certs:ro" -v "$WORK/nginx/htpasswd:/etc/nginx/delaipay-staging.htpasswd:ro" nginx:1.27-alpine >/dev/null
  sleep 2
  docker exec dp-stg-nginx nginx -t 2>&1 | grep -q "syntax is ok" && ok "nginx -t : configuration valide" || ko "nginx -t"
  C="curl -sk --resolve admin.staging.localhost:18443:127.0.0.1 --resolve hlz-demo.staging.localhost:18443:127.0.0.1 --resolve client2.staging.localhost:18443:127.0.0.1"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: hlz-demo.staging.localhost' http://127.0.0.1:18080/login)" = "301" ] && ok "HTTP → HTTPS (301)"
  $C -D - -o /dev/null https://admin.staging.localhost:18443/ | grep -qi 'strict-transport-security: max-age=31536000' && ok "HSTS présent"
  $C https://admin.staging.localhost:18443/ | grep -q 'Console plateforme' && ok "admin.staging.localhost → console"
  $C https://hlz-demo.staging.localhost:18443/api/tenant | grep -q '"known":true' && ok "hlz-demo.staging.localhost → espace (fictif)"
  $C https://admin.staging.localhost:18443/api/me | grep -q 'route_inconnue' && ok "aucune API d'espace sur l'hôte console"
  [ "$($C -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/octet-stream' --data-binary @<(head -c 27000000 /dev/zero) https://client2.staging.localhost:18443/api/clients/x/import)" = "413" ] && ok "requête > 26 Mo refusée par nginx (413)"
  # X-Forwarded-For forgé par le client : nginx le REMPLACE par l'adresse réelle — l'application ne voit jamais 203.0.113.99.
  $C -s -o /dev/null -H 'X-Forwarded-For: 203.0.113.99' -H 'Content-Type: application/json' -d '{"email":"x@y.z","password":"faux"}' https://hlz-demo.staging.localhost:18443/api/auth/login
  sqlite3 "$WORK/data/delaipay.db" "select ip from login_event order by created_at desc limit 1" | grep -qv '203.0.113.99' && ok "X-Forwarded-For forgé ignoré (IP enregistrée : $(sqlite3 "$WORK/data/delaipay.db" "select ip from login_event order by created_at desc limit 1"))"
  # Authentification basique nginx (facultative) : activée → 401 sans identifiants, 200 avec, /healthz toujours ouvert.
  sed -i.bak 's|# include /etc/nginx/snippets/delaipay-staging-basic-auth.conf;|include /etc/nginx/snippets/delaipay-staging-basic-auth.conf;|' nginx/site.conf
  docker exec dp-stg-nginx nginx -s reload >/dev/null 2>&1; sleep 1
  [ "$($C -o /dev/null -w '%{http_code}' https://hlz-demo.staging.localhost:18443/login)" = "401" ] && ok "basique activée : 401 sans identifiants"
  [ "$($C -o /dev/null -w '%{http_code}' -u fondateur:Staging-Basic-2026 https://hlz-demo.staging.localhost:18443/login)" = "200" ] && ok "basique : 200 avec identifiants"
  [ "$($C -o /dev/null -w '%{http_code}' https://hlz-demo.staging.localhost:18443/healthz)" = "200" ] && ok "/healthz reste ouvert (surveillance externe)"
  docker rm -f dp-stg-nginx >/dev/null
else echo "  (Docker indisponible : étape nginx non jouée)"; fi

step "5. Sauvegarde chiffrée → restauration dans un répertoire neuf → référence"
export GNUPGHOME="$(mktemp -d /tmp/dpg-XXXXXX)"; chmod 700 "$GNUPGHOME"   # chemin court (socket gpg-agent)
gpg --batch --passphrase '' --quick-gen-key 'Répétition <backup@staging.test>' default default 1d 2>/dev/null
( set -a; . ./staging.env; set +a; export BACKUP_GPG_RECIPIENT=backup@staging.test; cd root/current/app && node src/ops/backup.js | sed 's/^/    /' )
F="$(ls backups/*.gpg | head -1)"
( cd root/current/app && node src/ops/restore.js --from "$F" --to "$WORK/restored" | head -2 | sed 's/^/    /' )
( cd root/current/app && DB_PATH="$WORK/restored/delaipay.db" UPLOADS_DIR="$WORK/restored/uploads" TENANT_BASE_DOMAINS=staging.localhost JWT_SECRET=x \
  node src/ops/verify-baseline.js --slug hlz-demo --expect "36,16,350964.42,7025.33,a7d1acaac0688170ef95fce6b7bb2082" | tail -1 | sed 's/^/    /' )

step "Fin — arrêt de l'instance locale"
kill "$(cat app.pid)" 2>/dev/null || true
ok "Répétition terminée (répertoire : $WORK)"
