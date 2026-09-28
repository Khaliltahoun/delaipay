'use strict';
/**
 * Restauration d'une sauvegarde DelaiPay dans un répertoire NEUF (exercice de restauration ou reprise après incident).
 *
 *   node src/ops/restore.js --from <sauvegarde .tar.gz.age|.gpg> --to <répertoire neuf> [--identity <clé privée age>]
 *
 * - Vérifie l'empreinte (.sha256) si elle est présente à côté de la sauvegarde.
 * - Déchiffre avec la clé PRIVÉE de l'opérateur (age : --identity ; gpg : trousseau de l'opérateur) — clé jamais sur le serveur de sauvegardes.
 * - Extrait dans --to (qui doit être vide ou inexistant : jamais d'écrasement), contrôle d'intégrité de la base, affiche le manifeste.
 * La mise en service (remplacement de la base en production / staging) reste une décision manuelle : voir docs/STAGING.md.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function args() { const a = {}; const v = process.argv.slice(2); for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true; return a; }
function restore({ from, to, identity, env = process.env }) {
  if (!from || !fs.existsSync(from)) throw new Error('--from : sauvegarde introuvable.');
  if (!to) throw new Error('--to : répertoire cible requis.');
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error(`--to : « ${to} » n’est pas vide — la restauration n’écrase jamais un répertoire existant.`);
  const side = from + '.sha256';
  if (fs.existsSync(side)) {
    const want = fs.readFileSync(side, 'utf8').split(/\s+/)[0];
    const got = crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex');
    if (want !== got) throw new Error('Empreinte sha256 différente : sauvegarde altérée ou incomplète.');
  }
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  const tgz = path.join(to, '.restore.tar.gz');
  try {
    if (/\.age$/.test(from)) {
      if (!identity) throw new Error('--identity : clé privée age requise.');
      execFileSync(env.BACKUP_AGE_BIN || 'age', ['-d', '-i', identity, '-o', tgz, from], { stdio: 'pipe' });
    } else if (/\.gpg$/.test(from)) {
      execFileSync(env.BACKUP_GPG_BIN || 'gpg', ['--batch', '--yes', '--decrypt', '--output', tgz, from], { stdio: 'pipe' });
    } else throw new Error('Format inconnu : .tar.gz.age ou .tar.gz.gpg attendu.');
    execFileSync('tar', ['-xzf', tgz, '-C', to], { stdio: 'pipe' });
  } finally { fs.rmSync(tgz, { force: true }); }
  const db = path.join(to, 'delaipay.db');
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(db, { readOnly: true });
  const integ = Object.values(d.prepare('PRAGMA integrity_check').get())[0];
  d.close();
  if (integ !== 'ok') throw new Error('Base restaurée : contrôle d’intégrité en échec.');
  const manifest = JSON.parse(fs.readFileSync(path.join(to, 'manifest.json'), 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');
  if (sha !== manifest.db_sha256) throw new Error('Base restaurée différente de celle sauvegardée (empreinte).');
  return { db, uploads: fs.existsSync(path.join(to, 'uploads')) ? path.join(to, 'uploads') : null, manifest };
}
module.exports = { restore };
if (require.main === module) {
  try {
    const a = args();
    const r = restore({ from: a.from, to: a.to, identity: a.identity });
    console.log(`Restauration réussie dans ${a.to}\n  base : ${r.db} (intégrité ok, empreinte conforme au manifeste)\n  téléversements : ${r.uploads || '—'}\n  sauvegarde du ${r.manifest.at} · lignes ${JSON.stringify(r.manifest.lignes)}`);
    console.log(`Vérifier les chiffres : DB_PATH=${r.db} UPLOADS_DIR=${r.uploads || ''} npm run verify:baseline -- --slug <espace> --annee 2026 --trimestre 1`);
  } catch (e) { console.error('ÉCHEC de la restauration : ' + (e.stderr ? e.stderr.toString() : e.message)); process.exit(1); }
}
