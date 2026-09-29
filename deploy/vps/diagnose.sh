#!/usr/bin/env bash
# =====================================================================================================
# DelaiPay — DIAGNOSTIC EN LECTURE SEULE du VPS partagé (docs/VPS_ISOLATION.md §1).
#
#   sudo bash diagnose.sh 2>&1 | tee ~/vps-diagnosis.txt
#
# NE MODIFIE RIEN : aucune écriture hors de la sortie standard, aucun service démarré / arrêté, aucun démon PM2 lancé
# (pm2 n'est interrogé que pour les utilisateurs dont le démon tourne déjà), aucune règle ajoutée.
# Les VALEURS qui ressemblent à des secrets sont masquées (variables *KEY*, *TOKEN*, *SECRET*, *PASS*…, chaînes longues,
# identifiants dans les URL). Seuls les NOMS des variables d'environnement sont affichés, jamais leurs valeurs.
# Relisez quand même le fichier avant de me le coller.
# =====================================================================================================
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "À lancer avec sudo : sudo bash $0" >&2; exit 1; }
export LC_ALL=C.UTF-8 SYSTEMD_PAGER= SYSTEMD_COLORS=0

# Agents et sites connus (compléter si besoin) ; les autres unités « maison » sont découvertes automatiquement.
KNOWN="openclaw-agent openclaw-2 openclaw-dashboard seo-dashboard mission-assistant xnotify-web rsvp-telegram n8n"

mask() {
  sed -E \
    -e 's#NOPASSWD:#@NOPW@#g; s#(^|[^A-Za-z])PASSWD:#\1@PW@#g' \
    -e 's#([A-Za-z][A-Za-z0-9+.-]*://)[^/@[:space:]]+@#\1***@#g' \
    -e 's#((pass(word)?|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|cookie|session|bearer|jwt|dsn|webhook)[A-Za-z0-9_.-]*[[:space:]]*[=:][[:space:]]*"?)[^"[:space:],;]+#\1***#Ig' \
    -e 's#(Authorization:[[:space:]]*)[^[:space:]]+([[:space:]][^[:space:]]+)?#\1***#Ig' \
    -e 's#[0-9]{6,}:[A-Za-z0-9_-]{30,}#***#g' \
    -e 's#[A-Za-z0-9+_=-]{40,}#***#g' \
    -e 's#@NOPW@#NOPASSWD:#g; s#@PW@#PASSWD:#g'
}
h() { printf '\n\n########## %s\n' "$*"; }
s() { printf '\n--- %s\n' "$*"; }
run() { s "$*"; timeout 30 bash -c "$*" 2>&1 | mask; }

h "0. Machine"
run 'cat /etc/os-release | grep -E "^(PRETTY_NAME|VERSION_ID)="'
run 'uname -r; uname -m; systemctl --version | head -1'
run 'nproc; free -h | head -2; df -h / /srv /home /var 2>/dev/null | sort -u'
run 'command -v node && node -v; command -v docker && docker --version; command -v pm2; command -v nginx && nginx -v'
run 'dpkg -l auditd sudo 2>/dev/null | grep -E "^ii" | awk "{print \$2, \$3}"; systemctl is-active auditd 2>/dev/null'
run 'sshd -T 2>/dev/null | grep -Ei "^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|allowusers|allowgroups|denyusers|authorizedkeysfile|allowtcpforwarding|x11forwarding|strictmodes) "'
run 'ls -la /etc/ssh/sshd_config.d/ 2>/dev/null'

h "1. Comptes, groupes privilégiés, sudo"
run 'getent passwd | awk -F: "\$3==0 || \$3>=1000 || \$7 !~ /(nologin|false)\$/ {print \$1, \"uid=\"\$3, \"home=\"\$6, \"shell=\"\$7}"'
run 'for g in sudo admin wheel docker adm systemd-journal lxd libvirt disk shadow; do printf "%-16s %s\n" "$g" "$(getent group $g | cut -d: -f4)"; done'
run 'for u in $(getent passwd | awk -F: "\$3>=1000 && \$3<65534 {print \$1}"); do printf "%-20s %s\n" "$u" "$(passwd -S $u | awk "{print \$2}")"; done'
s "sudoers (lignes actives, sans commentaires)"
{ grep -Ehv '^\s*(#|$)' /etc/sudoers 2>/dev/null | sed 's/^/\/etc\/sudoers: /'
  for f in /etc/sudoers.d/*; do [ -f "$f" ] && grep -Ehv '^\s*(#|$)' "$f" | sed "s#^#$f: #"; done; } 2>&1 | mask
run 'ls -la /etc/sudoers.d/'
s "sudo -l pour chaque compte humain / d'agent"
for u in $(getent passwd | awk -F: '$3>=1000 && $3<65534 {print $1}'); do
  printf '\n[%s]\n' "$u"; sudo -l -U "$u" 2>&1 | sed -n '/may run/,$p' | mask
done
s "usage réel de sudo sur 30 jours (compte → commande, nombre)"
journalctl _COMM=sudo --since "-30 days" --no-pager -o cat 2>/dev/null \
  | sed -nE 's/^ *([^ :]+) : .*USER=([^ ;]+) ; COMMAND=(.*)$/\1 -> \2 : \3/p' | cut -c1-160 | sort | uniq -c | sort -rn | head -40 | mask

h "2. Services systemd : utilisateur, droits, durcissement"
CUSTOM="$(for f in /etc/systemd/system/*.service; do [ -f "$f" ] && [ ! -L "$f" ] && basename "$f"; done)"
UNITS="$(printf '%s\n' $KNOWN | sed 's/$/.service/'; printf '%s\n' $CUSTOM)"
for u in $(printf '%s\n' $UNITS | sort -u); do
  systemctl cat "$u" >/dev/null 2>&1 || { printf '\n[%s] absente\n' "$u"; continue; }
  s "$u"
  systemctl show "$u" -p ActiveState -p User -p Group -p DynamicUser -p SupplementaryGroups -p MainPID -p FragmentPath \
    -p WorkingDirectory -p ExecStart -p ReadWritePaths -p ProtectSystem -p ProtectHome -p NoNewPrivileges -p PrivateTmp \
    -p CapabilityBoundingSet 2>/dev/null | sed 's/ ; argv\[\]=/ argv=/; s/ ; ignore_errors.*//' | cut -c1-300 | mask
  printf 'variables d'"'"'environnement (NOMS seulement) : %s\n' \
    "$(systemctl show "$u" -p Environment --value 2>/dev/null | tr ' ' '\n' | cut -d= -f1 | grep -v '^$' | tr '\n' ' ')"
  systemctl cat "$u" 2>/dev/null | grep -E '^\s*EnvironmentFile=' | mask
  P="$(systemctl show "$u" -p MainPID --value)"; [ "${P:-0}" != 0 ] && printf 'processus : %s\n' "$(ps -o user=,group=,supgrp= -p "$P" 2>/dev/null)"
  systemd-analyze security "$u" 2>/dev/null | grep 'Overall exposure' | sed 's/^→ //'
done
run 'ls /var/lib/systemd/linger/ 2>/dev/null; loginctl list-users --no-legend 2>/dev/null'
s "unités systemd --user par compte"
for d in /home/*/.config/systemd/user /root/.config/systemd/user; do [ -d "$d" ] && { echo "$d"; ls -1 "$d" | grep -E '\.(service|timer)$'; }; done 2>&1 | mask
run 'systemctl list-timers --all --no-pager --no-legend | awk "{print \$(NF-1), \$NF}" | column -t'

h "3. Processus et ports"
run 'ps -eo user:20,pid,ppid,etime,args --sort=user | grep -vE "\[(kworker|ksoftirqd|migration|rcu_|cpuhp|idle_inject|irq/|kthreadd)" | grep -vE "diagnose\.sh|s#NOPASSWD|ps -eo user|timeout 30 bash" | cut -c1-220'
run 'ss -H -ltnup | awk "{print \$1, \$5, \$7}" | sort -k2 | column -t'

h "4. PM2 (uniquement là où le démon tourne déjà)"
for u in $(ps -eo user:32,args | awk '/PM2 v[0-9].*God Daemon/ {print $1}' | sort -u); do
  s "pm2 de $u"; H="$(getent passwd "$u" | cut -d: -f6)"
  sudo -u "$u" -H env PM2_HOME="$H/.pm2" pm2 ls --no-color 2>&1 | mask
  sudo -u "$u" -H env PM2_HOME="$H/.pm2" pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const p of JSON.parse(s)){const e=p.pm2_env||{};
    console.log([p.name,"user="+(e.username||""),"cwd="+(e.pm_cwd||""),"script="+(e.pm_exec_path||""),"env:"+Object.keys(e.env||{}).filter(k=>!/^(PM2|pm_|NODE_APP_INSTANCE|_)/.test(k)).join(",")].join("  "))}}catch(_){}})' 2>/dev/null | mask
done

h "5. cron"
run 'grep -Ehv "^\s*(#|$)" /etc/crontab /etc/cron.d/* 2>/dev/null'
for u in $(getent passwd | awk -F: '$3==0 || ($3>=1000 && $3<65534) {print $1}'); do
  c="$(crontab -l -u "$u" 2>/dev/null | grep -Ev '^\s*(#|$)')"; [ -n "$c" ] && { s "crontab de $u"; printf '%s\n' "$c" | cut -c1-220 | mask; }
done

h "6. Docker : conteneurs, privilèges, montages"
if command -v docker >/dev/null; then
  run 'docker info --format "rootless={{.SecurityOptions}} userns={{.Driver}} root={{.DockerRootDir}}" 2>/dev/null'
  run 'ls -l /var/run/docker.sock; stat -c "%U:%G %a" /var/run/docker.sock'
  run 'docker ps -a --format "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"'
  for c in $(docker ps -aq); do
    s "conteneur $(docker inspect -f '{{.Name}}' "$c")"
    docker inspect -f 'image={{.Config.Image}} user="{{.Config.User}}" privileged={{.HostConfig.Privileged}} network={{.HostConfig.NetworkMode}} pid={{.HostConfig.PidMode}} ipc={{.HostConfig.IpcMode}} userns={{.HostConfig.UsernsMode}} readonly_root={{.HostConfig.ReadonlyRootfs}} restart={{.HostConfig.RestartPolicy.Name}}
cap_add={{.HostConfig.CapAdd}} cap_drop={{.HostConfig.CapDrop}} security_opt={{.HostConfig.SecurityOpt}} devices={{len .HostConfig.Devices}}
ports={{range $p,$b := .HostConfig.PortBindings}}{{$p}}->{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}
compose={{index .Config.Labels "com.docker.compose.project.working_dir"}}
{{range .Mounts}}montage {{.Type}} {{.Source}} -> {{.Destination}} rw={{.RW}}
{{end}}env (NOMS) : {{range .Config.Env}}{{.}} {{end}}' "$c" 2>&1 \
      | sed -E '/^env \(NOMS\)/ s/=[^ ]*//g' | mask
    docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$c" | grep -Eq '^/(var/)?run/docker\.sock$' && echo '!!! docker.sock monté : ce conteneur est équivalent root sur l hôte'
    docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$c" | grep -Eq '^/(|srv|home|etc|root|var|opt)$' && echo '!!! montage large d un répertoire racine de l hôte'
  done
else echo "docker absent"; fi

h "7. Permissions des répertoires personnels et partagés"
run 'ls -ld / /home /home/* /root /srv /srv/* /opt /opt/* /var/www /var/www/* 2>/dev/null'
run 'grep -E "^(UMASK|HOME_MODE|USERGROUPS_ENAB)" /etc/login.defs; grep -E "^(DIR_MODE)" /etc/adduser.conf 2>/dev/null'
run 'getfacl -p --skip-base /home/* /srv/* /opt/* 2>/dev/null | grep -Ev "^$"'
s "fichiers sensibles LISIBLES PAR TOUS dans /home, /root, /srv, /opt (chemins seulement)"
find /home /root /srv /opt -xdev -maxdepth 5 -type f -perm -o+r \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name 'id_*' \
  -o -name '*.sqlite' -o -name '*.db' -o -name 'credentials*' -o -name '*.kdbx' -o -name 'config.json' \) -not -path '*/node_modules/*' 2>/dev/null | head -60
s "répertoires personnels lisibles par les autres"
for d in /home/* /root; do [ -d "$d" ] && [ "$(( 0$(stat -c '%a' "$d") & 5 ))" != 0 ] && echo "$d $(stat -c '%U %a' "$d")"; done

h "8. Ce dont chaque agent a besoin (lecture seule du code et des journaux — rien n'est modifié)"
for u in $(printf '%s\n' $UNITS | sort -u); do
  systemctl cat "$u" >/dev/null 2>&1 || continue
  W="$(systemctl show "$u" -p WorkingDirectory --value)"; s "$u (répertoire : ${W:-?})"
  if [ -n "$W" ] && [ -d "$W" ]; then
    printf 'appels sudo / docker / exécution de commandes dans le code (fichiers : nombre) :\n'
    grep -rEc --include='*.js' --include='*.ts' --include='*.mjs' --include='*.py' --include='*.sh' \
      '\bsudo\b|docker(\.sock|[[:space:]]+(exec|run|ps|compose|restart|logs))|child_process|execSync|spawnSync|subprocess\.|os\.system' \
      "$W" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=venv --exclude-dir=.venv 2>/dev/null | grep -v ':0$' | head -15
    printf 'chemins absolus de l hôte cités dans le code / la config :\n'
    grep -rEoh --include='*.js' --include='*.ts' --include='*.py' --include='*.sh' --include='*.json' --include='*.yml' --include='*.yaml' \
      '"/(home|srv|etc|var|opt|root)/[A-Za-z0-9._/-]+' "$W" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | tr -d '"' | sort | uniq -c | sort -rn | head -12 | mask
  fi
  printf 'journal (7 jours) — refus / sudo / docker :\n'
  journalctl -u "$u" --since '-7 days' --no-pager -o cat 2>/dev/null | grep -Ei 'permission denied|EACCES|EPERM|sudo|docker|not permitted' | tail -5 | cut -c1-200 | mask
done

h "9. Production DelaiPay (:3200) — lecture seule"
run 'ss -H -ltnp "( sport = :3200 )"'
command -v docker >/dev/null && run 'docker ps --filter publish=3200 --format "{{.Names}} {{.Image}} {{.Status}}"'

printf '\n\nFin du diagnostic (%s). Rien n’a été modifié. Relisez ce fichier avant de le coller.\n' "$(date -u +%FT%TZ)"
