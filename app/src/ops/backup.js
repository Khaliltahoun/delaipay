'use strict';
/**
 * Sauvegarde chiffrée de DelaiPay (3B) — base SQLite + fichiers téléversés.
 *
 *   npm run backup                 (variables : voir deploy/staging.env.example, section « Sauvegardes »)
 *
 * 1. Copie À CHAUD par l'API de sauvegarde en ligne de SQLite (node:sqlite `backup()`), jamais une copie de fichier
 *    d'une base ouverte ; contrôle d'intégrité (PRAGMA integrity_check) de la copie.
 * 2. Archive tar.gz : base + manifeste (date, version, empreinte, volumétrie) + répertoire des téléversements.
 * 3. Chiffrement OBLIGATOIRE vers une clé PUBLIQUE : age (BACKUP_AGE_RECIPIENT) ou gpg (BACKUP_GPG_RECIPIENT).
 *    Le serveur ne détient jamais la clé privée : une sauvegarde volée est illisible ; la clé privée vit hors ligne.
 * 4. Rotation (7 quotidiennes, 4 hebdomadaires, 12 mensuelles par défaut), copie hors site (BACKUP_OFFSITE_CMD).
 * 5. État écrit dans BACKUP_STATUS_FILE (lu par la console : dernière réussite, taille, alerte > 26 h, échec).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');

const env = process.env;
const DB_PATH = env.DB_PATH;
const UPLOADS = env.UPLOADS_DIR || null;
const DIR = env.BACKUP_DIR;
const STATUS = env.BACKUP_STATUS_FILE || (DB_PATH ? path.join(path.dirname(DB_PATH), 'backup-status.json') : null);
const PREFIX = env.BACKUP_PREFIX || 'delaipay';
const POLICY = { daily: +(env.BACKUP_KEEP_DAILY || 7), weekly: +(env.BACKUP_KEEP_WEEKLY || 4), monthly: +(env.BACKUP_KEEP_MONTHLY || 12) };

function writeStatus(patch) {
  if (!STATUS) return;
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch (_) {}
  Object.assign(st, patch);
  fs.writeFileSync(STATUS + '.tmp', JSON.stringify(st, null, 2), { mode: 0o640 }); fs.renameSync(STATUS + '.tmp', STATUS);
}
const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');   // 20260928-023000Z
const parseStamp = name => { const m = name.match(/-(\d{8})-(\d{6})Z\./); return m ? new Date(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4)}Z`) : null; };

/**
 * Rotation grand-père / père / fils : garde la plus récente sauvegarde de chacun des N derniers jours, semaines ISO et mois
 * (en UTC). Fonction pure, testée. @returns {Set<string>} noms à conserver
 */
function selectKeep(names, policy = POLICY) {
  const items = names.map(n => ({ n, d: parseStamp(n) })).filter(x => x.d).sort((a, b) => b.d - a.d);
  const keep = new Set();
  const isoWeek = d => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = t.getUTCFullYear(); return `${y}-W${Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7)}`; };
  for (const [key, n] of [[d => d.toISOString().slice(0, 10), policy.daily], [isoWeek, policy.weekly], [d => d.toISOString().slice(0, 7), policy.monthly]]) {
    const seen = new Set();
    for (const it of items) { const k = key(it.d); if (seen.has(k)) continue; if (seen.size >= n) break; seen.add(k); keep.add(it.n); }
  }
  if (items[0]) keep.add(items[0].n); // la plus récente, toujours
  return keep;
}

function encrypt(input, output) {
  if (env.BACKUP_AGE_RECIPIENT) {
    const r = env.BACKUP_AGE_RECIPIENT;
    const args = fs.existsSync(r) ? ['-R', r] : ['-r', r];
    execFileSync(env.BACKUP_AGE_BIN || 'age', [...args, '-o', output, input], { stdio: 'pipe' });
    return 'age';
  }
  if (env.BACKUP_GPG_RECIPIENT) {
    execFileSync(env.BACKUP_GPG_BIN || 'gpg', ['--batch', '--yes', '--trust-model', 'always', '--encrypt', '--recipient', env.BACKUP_GPG_RECIPIENT, '--output', output, input], { stdio: 'pipe' });
    return 'gpg';
  }
  throw new Error('Aucune clé de chiffrement : définissez BACKUP_AGE_RECIPIENT (recommandé) ou BACKUP_GPG_RECIPIENT. Une sauvegarde n’est jamais écrite en clair.');
}

async function run() {
  const started = Date.now(), at = new Date();
  if (!DB_PATH || !fs.existsSync(DB_PATH)) throw new Error('DB_PATH absent ou introuvable.');
  if (!DIR) throw new Error('BACKUP_DIR non défini.');
  if (path.resolve(DIR).startsWith(path.resolve(path.dirname(DB_PATH)) + path.sep) && !env.BACKUP_ALLOW_SAME_DISK_DIR)
    console.warn('Avertissement : BACKUP_DIR est sous le répertoire de la base — la copie hors site (BACKUP_OFFSITE_CMD) est indispensable.');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(DIR, '.tmp-'));
  try {
    // 1. Copie à chaud (API de sauvegarde en ligne) + intégrité
    const { DatabaseSync, backup } = require('node:sqlite');
    const src = new DatabaseSync(DB_PATH);
    const copy = path.join(work, 'delaipay.db');
    await backup(src, copy);
    src.close();
    const chk = new DatabaseSync(copy, { readOnly: true });
    const integ = chk.prepare('PRAGMA integrity_check').get();
    const counts = {};
    for (const t of ['cabinet', 'utilisateur', 'entreprise', 'facture', 'audit_log']) { try { counts[t] = chk.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch (_) { counts[t] = null; } }
    chk.close();
    if (Object.values(integ)[0] !== 'ok') throw new Error('Contrôle d’intégrité de la copie en échec : ' + JSON.stringify(integ));
    const manifest = { format: 'delaipay-sauvegarde', version: 1, at: at.toISOString(), source: path.basename(DB_PATH), db_sha256: crypto.createHash('sha256').update(fs.readFileSync(copy)).digest('hex'),
      lignes: counts, uploads: !!(UPLOADS && fs.existsSync(UPLOADS)), app: env.APP_COMMIT || null };
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // 2. Archive
    const tgz = path.join(work, 'bundle.tar.gz');
    const tarArgs = ['-czf', tgz, '-C', work, 'delaipay.db', 'manifest.json'];
    if (manifest.uploads) tarArgs.push('-C', path.dirname(path.resolve(UPLOADS)), path.basename(path.resolve(UPLOADS)));
    execFileSync('tar', tarArgs, { stdio: 'pipe' });
    // 3. Chiffrement vers une clé publique
    const tmpOut = path.join(work, 'out');
    const kind = encrypt(tgz, tmpOut);
    const name = `${PREFIX}-${stamp(at)}.tar.gz.${kind}`;
    const final = path.join(DIR, name);
    fs.renameSync(tmpOut, final); fs.chmodSync(final, 0o600);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(final)).digest('hex');
    fs.writeFileSync(final + '.sha256', `${sha}  ${name}\n`, { mode: 0o600 });
    const size = fs.statSync(final).size;
    // 4. Rotation, copie hors site
    const all = fs.readdirSync(DIR).filter(f => f.startsWith(PREFIX + '-') && /\.tar\.gz\.(age|gpg)$/.test(f));
    const keep = selectKeep(all);
    const removed = [];
    for (const f of all) if (!keep.has(f)) { fs.rmSync(path.join(DIR, f), { force: true }); fs.rmSync(path.join(DIR, f + '.sha256'), { force: true }); removed.push(f); }
    let offsite = null;
    if (env.BACKUP_OFFSITE_CMD) {
      execSync(env.BACKUP_OFFSITE_CMD.replace(/\{file\}/g, JSON.stringify(final)).replace(/\{dir\}/g, JSON.stringify(DIR)), { stdio: 'pipe', timeout: 30 * 60e3 });
      offsite = 'ok';
    }
    const res = { at: at.toISOString(), ok: true, file: name, taille: size, sha256: sha, chiffrement: kind, dureeMs: Date.now() - started, lignes: counts, supprimees: removed.length, horsSite: offsite };
    writeStatus({ lastAttempt: { at: at.toISOString(), ok: true }, lastSuccess: res });
    return res;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { run, selectKeep, parseStamp, stamp };
if (require.main === module) {
  run().then(r => { console.log(`Sauvegarde réussie : ${r.file} (${r.taille} octets, ${r.chiffrement}, sha256 ${r.sha256.slice(0, 16)}…) ; ${r.supprimees} ancienne(s) supprimée(s) ; hors site : ${r.horsSite || 'non configuré'}.`); })
    .catch(e => {
      const msg = String(e && (e.stderr ? e.stderr.toString() : e.message) || e).trim().slice(0, 400);
      try { writeStatus({ lastAttempt: { at: new Date().toISOString(), ok: false, error: msg } }); } catch (_) {}
      console.error('ÉCHEC de la sauvegarde : ' + msg); process.exit(1);
    });
}
