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

function snapshot() {
  return { startedAt: new Date(STARTED_AT).toISOString(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), errors, commit: COMMIT };
}

module.exports = { countError, snapshot, STARTED_AT };
