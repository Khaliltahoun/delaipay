'use strict';
/** État du processus pour la console (version, démarrage, erreurs non gérées depuis le démarrage). */
const fs = require('fs');
const path = require('path');

const STARTED_AT = Date.now();
let errors = 0;
function countError() { errors++; }

/** Commit courant lu dans .git (sans exécuter git) ; APP_COMMIT prioritaire (déploiement). */
function gitCommit() {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT.slice(0, 12);
  // Version déployée (deploy/deploy.sh écrit REVISION à la racine de la version, sans dépôt git).
  try { const r = fs.readFileSync(path.join(__dirname, '..', '..', 'REVISION'), 'utf8').trim(); if (/^[0-9a-f]{7,40}$/.test(r)) return r.slice(0, 7); } catch (_) {}
  try {
    const gitDir = path.join(__dirname, '..', '..', '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    const ref = head.slice(5).trim();
    try { return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 7); } catch (_) {}
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find(l => l.endsWith(' ' + ref));
    return line ? line.slice(0, 7) : null;
  } catch (_) { return null; }
}
const COMMIT = gitCommit();

/** Espace disque du volume des données (fs.statfs) : alerte sous 10 % ou 2 Go libres. */
function disk(dir) {
  try {
    const st = fs.statfsSync(dir);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    const pct = total ? Math.round(1000 * free / total) / 10 : null;
    return { total, libre: free, pctLibre: pct, alerte: free < 2 * 1024 ** 3 || (pct != null && pct < 10) };
  } catch (_) { return null; }
}
/**
 * État de la dernière sauvegarde, écrit par `npm run backup` (src/ops/backup.js) dans BACKUP_STATUS_FILE
 * (défaut : à côté de la base). En retard si la dernière réussite date de plus de 26 h ; en échec si la
 * dernière tentative a échoué.
 */
function backupStatus(dbPath) {
  const file = process.env.BACKUP_STATUS_FILE || path.join(path.dirname(dbPath), 'backup-status.json');
  let st = null; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { configure: false, message: 'Aucune sauvegarde configurée' }; }
  const last = st.lastSuccess || null;
  const ageH = last ? (Date.now() - Date.parse(last.at)) / 3600e3 : null;
  const echec = st.lastAttempt && st.lastAttempt.ok === false && (!last || Date.parse(st.lastAttempt.at) >= Date.parse(last.at)) ? st.lastAttempt : null;
  return { configure: true, derniere: last, ageHeures: ageH == null ? null : Math.round(ageH * 10) / 10,
    enRetard: ageH == null || ageH > 26, echec, alerte: !!echec || ageH == null || ageH > 26 };
}
function snapshot() {
  return { startedAt: new Date(STARTED_AT).toISOString(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), errors, commit: COMMIT };
}

/** Identifiant de requête : celui du proxy (X-Request-Id) s'il est sûr, sinon généré ; renvoyé dans la réponse. */
function requestId(req, res, next) {
  const inc = String(req.headers['x-request-id'] || '');
  req.id = /^[A-Za-z0-9._-]{8,64}$/.test(inc) ? inc : require('crypto').randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}
/** Journal d'erreur SANS donnée sensible : identifiant, méthode, chemin (sans requête), message — jamais le corps ni les cookies. */
function logError(req, err) {
  countError();
  const p = String((req && (req.originalUrl || req.url)) || '').split('?')[0];
  console.error(`[erreur] req=${req && req.id || '-'} ${req && req.method || '-'} ${p} — ${err && err.name || 'Error'}: ${String(err && err.message || err).slice(0, 300)}`);
  if (err && err.stack && process.env.NODE_ENV !== 'production') console.error(err.stack.split('\n').slice(1, 6).join('\n'));
}

module.exports = { countError, snapshot, STARTED_AT, disk, backupStatus, requestId, logError };
