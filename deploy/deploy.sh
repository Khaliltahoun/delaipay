#!/usr/bin/env bash
# =====================================================================================================
# DelaiPay — déploiement par versions (staging), avec sauvegarde, tests, santé et retour arrière automatique.
#
#   (connecté en SSH comme delaipay-staging)  /srv/delaipay-staging/deploy.sh <commit|tag|branche>
#
# Tourne SANS aucun secret : le fichier d'environnement (root:root 600) n'est lu que par systemd au démarrage du
# service. Les seules informations nécessaires (chemins, URL de santé, dépôt) sont dans DEPLOY_CONF, non secret.
# Seule action privilégiée : « sudo -n systemctl restart delaipay-staging.service » (règle sudoers limitée à cette commande).
#
# Étapes : verrou → récupération du commit (miroir git local) → nouvelle version dans releases/<date>-<sha>
#          → npm ci → suite de tests complète (environnement vierge) → sauvegarde de la base (API SQLite)
#          → migrations additives → bascule du lien « current » → redémarrage → contrôle de santé
#          (HTTP 200 + commit attendu) → en cas d'échec : retour à la version précédente, redémarrage, contrôle.
# Aucune donnée n'est dans les versions : base et téléversements dans shared/, secrets dans le fichier d'environnement du service (lu par systemd seul).
# =====================================================================================================
set -Eeuo pipefail
REF="${1:?Usage : deploy.sh <commit|tag|branche>}"

# Racine = répertoire du script (/srv/delaipay-staging/deploy.sh → staging ; /srv/delaipay/deploy.sh → production)
DEPLOY_ROOT="${DEPLOY_ROOT:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
DEPLOY_CONF="${DEPLOY_CONF:-$DEPLOY_ROOT/deploy.conf}"
# Paramètres non secrets : REPO_URL, DB_PATH, HEALTH_URL… (les variables déjà définies dans l'environnement priment)
if [ -r "$DEPLOY_CONF" ]; then while IFS='=' read -r k v || [ -n "$k" ]; do case "$k" in ''|\#*) continue;; esac; [ -z "${!k:-}" ] && export "$k=$v"; done < "$DEPLOY_CONF"; fi
# Node.js propre à DelaiPay (ex. /opt/node-24) : prioritaire sur celui du système
if [ -n "${NODE_DIR:-}" ]; then export PATH="$NODE_DIR/bin:$PATH"; fi
REPO_URL="${REPO_URL:?REPO_URL requis (dépôt git en lecture seule, ex. clé de déploiement) — dans $DEPLOY_CONF}"
SERVICE="${SERVICE:-delaipay-staging.service}"
RESTART_CMD="${RESTART_CMD:-sudo -n /usr/bin/systemctl restart ${SERVICE}}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4200/healthz}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
NPM_CI_CMD="${NPM_CI_CMD:-npm ci --omit=dev --no-audit --no-fund}"
RUN_TESTS="${RUN_TESTS:-1}"

RELEASES="$DEPLOY_ROOT/releases"; CURRENT="$DEPLOY_ROOT/current"; MIRROR="$DEPLOY_ROOT/repo.git"
PREDEPLOY="$DEPLOY_ROOT/pre-deploy"; LOG="$DEPLOY_ROOT/deploy.log"
mkdir -p "$RELEASES" "$PREDEPLOY"
exec > >(tee -a "$LOG") 2>&1
say() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ---- verrou : un seul déploiement à la fois
LOCK="$DEPLOY_ROOT/.deploy.lock"
if ! mkdir "$LOCK" 2>/dev/null; then say "Un déploiement est déjà en cours ($LOCK)."; exit 1; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# ---- base de données (chemin non secret, identique à celui du fichier d'environnement du service)
: "${DB_PATH:?DB_PATH absent de $DEPLOY_CONF}"

# ---- 1. récupération du commit
# GIT_BRANCH (deploy.conf) : miroir superficiel limité à cette branche (+ étiquettes) ; sinon miroir complet.
if [ -n "${GIT_BRANCH:-}" ]; then
  [ -d "$MIRROR" ] || git clone --bare --depth 1 --single-branch --branch "$GIT_BRANCH" "$REPO_URL" "$MIRROR" >/dev/null
  git --git-dir="$MIRROR" fetch --depth 1 --prune --tags origin "+refs/heads/${GIT_BRANCH}:refs/heads/${GIT_BRANCH}" >/dev/null
elif [ -d "$MIRROR" ]; then git --git-dir="$MIRROR" fetch --prune --tags origin '+refs/heads/*:refs/heads/*' >/dev/null
else git clone --mirror "$REPO_URL" "$MIRROR" >/dev/null; fi
SHA="$(git --git-dir="$MIRROR" rev-parse --verify "${REF}^{commit}")"
SHORT="${SHA:0:7}"
NEW="$RELEASES/$(date -u +%Y%m%d-%H%M%S)-$SHORT"
PREV="$(readlink "$CURRENT" 2>/dev/null || true)"
say "Déploiement de $REF → $SHA (précédente : ${PREV:-aucune})"

mkdir -p "$NEW"
git --git-dir="$MIRROR" archive "$SHA" | tar -x -C "$NEW"
echo "$SHA" > "$NEW/REVISION"

# ---- 2. dépendances et tests (environnement VIERGE : jamais la base ni les secrets du staging)
( cd "$NEW/app" && eval "$NPM_CI_CMD" )
if [ "$RUN_TESTS" = "1" ]; then
  say "Suite de tests…"
  ( cd "$NEW/app" && env -i PATH="$PATH" HOME="$(mktemp -d)" TMPDIR="$(mktemp -d)" npm test >"$NEW/test.log" 2>&1 ) \
    || { cp "$NEW/test.log" "$DEPLOY_ROOT/tests-echec-$SHORT.log"; say "ÉCHEC des tests — rien n'est modifié (journal : $DEPLOY_ROOT/tests-echec-$SHORT.log)."; grep -E '^(ℹ (pass|fail)|✖)' "$NEW/test.log" | head -10; rm -rf "$NEW"; exit 1; }
  say "Tests : $(grep -E '^ℹ (pass|fail)' "$NEW/test.log" | tr '\n' ' ')"
fi

# ---- 3. sauvegarde de pré-déploiement (API de sauvegarde en ligne de SQLite) puis migrations additives
BK="$PREDEPLOY/$(basename "$NEW").db"
if [ -f "$DB_PATH" ]; then
  ( cd "$NEW/app" && node -e "require('node:sqlite').backup(new (require('node:sqlite').DatabaseSync)(process.argv[1]), process.argv[2]).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})" "$DB_PATH" "$BK" )
  chmod 600 "$BK"; say "Base sauvegardée avant migration : $BK"
fi
( cd "$NEW/app" && DB_PATH="$DB_PATH" node src/ops/migrate-schema.js && DB_PATH="$DB_PATH" node src/migrate.js >/dev/null )

# ---- 4. bascule + redémarrage + santé
switch_to() { ln -sfn "$1" "$CURRENT.tmp" && mv -Tf "$CURRENT.tmp" "$CURRENT" 2>/dev/null || { rm -f "$CURRENT"; ln -s "$1" "$CURRENT"; }; }
healthy() {
  local want="$1" i body
  for i in $(seq 1 "$HEALTH_TRIES"); do
    body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"ok":true' && printf '%s' "$body" | grep -q "\"commit\":\"$want"; then return 0; fi
    sleep 2
  done
  return 1
}
switch_to "$NEW"
eval "$RESTART_CMD"
if healthy "$SHORT"; then
  say "Santé OK — version $SHORT en service."
else
  say "ÉCHEC du contrôle de santé de $SHORT — RETOUR ARRIÈRE."
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    switch_to "$PREV"; eval "$RESTART_CMD"
    PSHA="$(cut -c1-7 "$PREV/REVISION" 2>/dev/null || true)"
    if healthy "$PSHA"; then say "Retour arrière réussi : $PSHA de nouveau en service."; else say "ALERTE : la version précédente ne répond pas non plus — intervention manuelle (base sauvegardée : $BK)."; fi
  else say "ALERTE : aucune version précédente — intervention manuelle."; fi
  mv "$NEW" "$NEW.echec" 2>/dev/null || true
  exit 2
fi

# ---- 5. nettoyage : versions et sauvegardes de pré-déploiement au-delà de KEEP_RELEASES
ls -1dt "$RELEASES"/*/ 2>/dev/null | grep -v '\.echec/$' | tail -n +"$((KEEP_RELEASES + 1))" | while read -r d; do [ "${d%/}" != "$(readlink "$CURRENT")" ] && rm -rf "$d"; done || true
ls -1t "$PREDEPLOY"/*.db 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r f; do rm -f "$f"; done || true
say "Terminé."
