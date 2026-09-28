'use strict';
/* INC 3B — exploitation : sauvegarde chiffrée (API de sauvegarde SQLite), rotation, restauration dans un répertoire neuf,
 * contrôle de la référence sur la base restaurée, état de sauvegarde lu par la console, garde du seed de staging. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dp_ops_'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {} });
const APP = path.join(__dirname, '..');
const DB = path.join(ROOT, 'live', 'delaipay.db'); fs.mkdirSync(path.dirname(DB), { recursive: true });
const UP = path.join(ROOT, 'live', 'uploads');

// Trousseau gpg JETABLE (clé sans phrase de passe, uniquement pour le test) : le serveur n'a besoin que de la clé publique.
const GNUPGHOME = path.join(ROOT, 'gnupg'); fs.mkdirSync(GNUPGHOME, { mode: 0o700 });
const genv = { ...process.env, GNUPGHOME };
execFileSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'Sauvegarde DelaiPay (test) <backup@delaipay.test>', 'default', 'default', '1d'], { env: genv, stdio: 'pipe' });

const run = (script, args = [], extra = {}) => execFileSync(process.execPath, [path.join(APP, 'src', 'ops', script), ...args],
  { env: { ...genv, DB_PATH: DB, UPLOADS_DIR: UP, JWT_SECRET: 'secret-de-test-ops', TENANT_BASE_DOMAINS: 'localhost', DELAIPAY_AUTO_SEED: '0', ...extra }, stdio: 'pipe' }).toString();

test('ops : base de démonstration fictive (référence) préparée', () => {
  execFileSync(process.execPath, ['-e', "require('./src/seed').ensureSeed().then(() => process.exit(0))"],
    { cwd: APP, env: { ...process.env, DB_PATH: DB, UPLOADS_DIR: UP, ADMIN_PASSWORD: 'Mot-de-passe-ops-1' }, stdio: 'pipe' });
  assert.ok(fs.existsSync(DB));
});

test('sauvegarde : refusée sans clé de chiffrement (jamais en clair) ; échec inscrit dans l’état', () => {
  const dir = path.join(ROOT, 'bk-none');
  assert.throws(() => run('backup.js', [], { BACKUP_DIR: dir }), /Aucune clé de chiffrement/);
  const st = JSON.parse(fs.readFileSync(path.join(path.dirname(DB), 'backup-status.json'), 'utf8'));
  assert.equal(st.lastAttempt.ok, false); assert.match(st.lastAttempt.error, /clé de chiffrement/);
  const b = require('../src/runtime').backupStatus(DB);
  assert.equal(b.alerte, true); assert.ok(b.echec, 'la console signale l’échec');
  assert.ok(!fs.readdirSync(dir).some(f => /\.tar\.gz$/.test(f)), 'aucun fichier en clair');
});

test('sauvegarde → restauration dans un répertoire neuf → référence et md5 identiques', () => {
  const dir = path.join(ROOT, 'bk');
  const out = run('backup.js', [], { BACKUP_DIR: dir, BACKUP_GPG_RECIPIENT: 'backup@delaipay.test', BACKUP_PREFIX: 'delaipay-test' });
  assert.match(out, /Sauvegarde réussie : delaipay-test-\d{8}-\d{6}Z\.tar\.gz\.gpg/);
  const file = fs.readdirSync(dir).find(f => f.endsWith('.gpg'));
  assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(dir, file + '.sha256')));
  assert.ok(!fs.readFileSync(path.join(dir, file)).includes(Buffer.from('SQLite format 3')), 'contenu chiffré (pas d’en-tête SQLite lisible)');
  // État lu par la console : dernière réussite, taille, pas d'alerte.
  const b = require('../src/runtime').backupStatus(DB);
  assert.equal(b.alerte, false); assert.equal(b.derniere.file, file); assert.ok(b.derniere.taille > 1000);
  // Restauration : refus sur un répertoire non vide, succès dans un répertoire neuf.
  const busy = path.join(ROOT, 'busy'); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, 'x'), 'x');
  assert.throws(() => run('restore.js', ['--from', path.join(dir, file), '--to', busy]), /n’est pas vide/);
  const to = path.join(ROOT, 'restored');
  assert.match(run('restore.js', ['--from', path.join(dir, file), '--to', to]), /Restauration réussie/);
  assert.ok(fs.existsSync(path.join(to, 'delaipay.db')) && fs.existsSync(path.join(to, 'manifest.json')));
  const v = JSON.parse(run('verify-baseline.js', ['--slug', 'hlz'], { DB_PATH: path.join(to, 'delaipay.db'), UPLOADS_DIR: path.join(to, 'uploads') }).replace(/^[^{]*/, '').split('\n}')[0] + '\n}');
  assert.deepEqual([v.factures, v.lignes, v.ttc, v.amende, v.csv_md5], [36, 16, 350964.42, 7025.33, 'a7d1acaac0688170ef95fce6b7bb2082']);
  // Altération détectée.
  const bad = path.join(ROOT, 'bad.tar.gz.gpg'); fs.copyFileSync(path.join(dir, file), bad); fs.copyFileSync(path.join(dir, file + '.sha256'), bad + '.sha256');
  fs.appendFileSync(bad, 'x');
  assert.throws(() => run('restore.js', ['--from', bad, '--to', path.join(ROOT, 'r2')]), /Empreinte sha256 différente/);
});

test('sauvegarde : rotation 7 quotidiennes / 4 hebdomadaires / 12 mensuelles', () => {
  const { selectKeep, stamp } = require('../src/ops/backup');
  const names = [];
  const t0 = Date.UTC(2026, 8, 28, 2, 30);
  for (let i = 0; i < 400; i++) for (const h of [0, 12]) names.push(`delaipay-${stamp(new Date(t0 - i * 864e5 - h * 3600e3))}.tar.gz.age`);
  const keep = selectKeep(names, { daily: 7, weekly: 4, monthly: 12 });
  const days = [...keep].map(n => n.match(/-(\d{8})-/)[1]);
  assert.ok(keep.size >= 12 && keep.size <= 23, `taille ${keep.size}`);
  for (let i = 0; i < 7; i++) assert.ok(days.includes(new Date(t0 - i * 864e5).toISOString().slice(0, 10).replace(/-/g, '')), 'les 7 derniers jours');
  assert.equal(new Set(days.map(d => d.slice(0, 6))).size, 12, '12 mois distincts');
  assert.ok(keep.has(names[0]), 'la plus récente');
});

test('console : sauvegarde de plus de 26 h signalée ; disque mesuré', () => {
  const runtime = require('../src/runtime');
  const f = path.join(ROOT, 'status-old.json');
  fs.writeFileSync(f, JSON.stringify({ lastAttempt: { at: new Date(Date.now() - 30 * 3600e3).toISOString(), ok: true }, lastSuccess: { at: new Date(Date.now() - 30 * 3600e3).toISOString(), file: 'x', taille: 10 } }));
  process.env.BACKUP_STATUS_FILE = f;
  try { const b = runtime.backupStatus(DB); assert.equal(b.enRetard, true); assert.equal(b.alerte, true); assert.ok(b.ageHeures >= 29); }
  finally { delete process.env.BACKUP_STATUS_FILE; }
  const d = runtime.disk(ROOT);
  assert.ok(d && d.total > 0 && d.libre > 0 && typeof d.alerte === 'boolean');
});

test('staging : le seed refuse hors staging, sur un domaine de production, et sur une base non vide', () => {
  const { guard } = require('../src/ops/staging-seed');
  assert.throws(() => guard({ DB_PATH: 'x' }), /DELAIPAY_ENV=staging/);
  assert.throws(() => guard({ DELAIPAY_ENV: 'staging', NODE_ENV: 'production', DB_PATH: 'x', TENANT_BASE_DOMAINS: 'delaipay.hlzconsulting.ma' }), /domaine de staging/);
  assert.doesNotThrow(() => guard({ DELAIPAY_ENV: 'staging', NODE_ENV: 'production', DB_PATH: 'x', TENANT_BASE_DOMAINS: 'staging.delaipay.com' }));
  assert.throws(() => run('staging-seed.js', [], { DELAIPAY_ENV: 'staging' }), /pas vide/);
});

test('santé : /healthz sans secret ni donnée d’espace, identifiant de requête renvoyé', async () => {
  const src = fs.readFileSync(path.join(APP, 'src', 'app.js'), 'utf8');
  assert.match(src, /app\.get\('\/healthz'/);
  const out = execFileSync(process.execPath, ['-e', `
    const { createApp } = require('./src/app'); const http = require('http');
    const s = createApp().listen(0, () => http.get({ host: '127.0.0.1', port: s.address().port, path: '/healthz', headers: { 'X-Request-Id': 'abcdef123456' } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { console.log(JSON.stringify({ status: r.statusCode, rid: r.headers['x-request-id'], body: JSON.parse(b) })); s.close(); });
    }));`], { cwd: APP, env: { ...process.env, DB_PATH: DB, DELAIPAY_AUTO_SEED: '0' }, stdio: 'pipe' }).toString();
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.status, 200); assert.equal(r.rid, 'abcdef123456'); assert.equal(r.body.ok, true); assert.equal(r.body.db, 'ok');
  assert.deepEqual(Object.keys(r.body).sort(), ['commit', 'db', 'ok', 'ts', 'uptimeSec', 'version']);
});
