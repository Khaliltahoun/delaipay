'use strict';
/* INC 3A — Console plateforme : identité, 2FA, sessions, séparation stricte console ↔ espaces. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_platform_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} } });
// Chaque « navigateur » simulé présente sa propre IP via un proxy de confiance local (limites de débit par IP).
process.env.TRUST_PROXY = 'loopback';

const H = require('./helpers/http');
const { db } = require('../src/db');
const store = require('../src/platform/store');
const pauth = require('../src/platform/auth');
const totp = require('../src/platform/totp');
const workspace = require('../src/workspace');
const auth = require('../src/auth');
after(() => H.stop());

const ADMIN = 'admin.localhost';
const PW = 'Plateforme-Sure-2026!';
let ipSeq = 10;
const newIp = () => `198.51.100.${ipSeq++}`;
function consoleBrowser(ip = newIp()) { return H.browser(ADMIN, { headers: { 'X-Forwarded-For': ip, 'X-DP-Console': '1', 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/128' } }); }
let admSeq = 0;
function newAdmin() { const email = `ops${++admSeq}-${process.pid}@delaipay.test`; pauth.createAdmin({ email, nom: 'Opérateur ' + admSeq, password: PW }); return email; }
/** Connexion complète avec enrôlement : renvoie { b, secret, codes }. */
async function enrolled(email = newAdmin(), b = consoleBrowser()) {
  let r = await b.post('/api/platform/auth/login', { email, password: PW });
  assert.equal(r.status, 200); assert.equal(r.body.next, 'enrolement');
  r = await b.get('/api/platform/auth/enrolment');
  assert.equal(r.status, 200);
  const secret = r.body.secret.replace(/\s/g, '');
  r = await b.post('/api/platform/auth/enrolment', { code: totp.totp(secret) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { b, secret, codes: r.body.recoveryCodes, email };
}

test('console : slugs réservés refusés à la création d’espace', () => {
  for (const s of ['admin', 'www', 'api', 'app', 'mail', 'status', 'support', 'static']) {
    assert.throws(() => workspace.createWorkspace({ slug: s, nom: 'X', admin: { email: `a@${s}.ma`, nom: 'A', password: 'Secret-1234' } }), /Cet identifiant est réservé/, s);
  }
});

test('console : admin.localhost sert la console, jamais l’application d’un espace', async () => {
  const page = await H.request('GET', '/', { host: ADMIN, raw: true });
  assert.equal(page.status, 200);
  assert.match(page.text, /Console plateforme/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'(;|$)/, 'aucun script inline autorisé');
  assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
  for (const p of ['/api/me', '/api/tenant', '/api/auth/login', '/login', '/invite']) {
    const r = await H.request(p.includes('login') && p.startsWith('/api') ? 'POST' : 'GET', p, { host: ADMIN, raw: true, headers: { 'X-DP-Console': '1' } });
    assert.equal(r.status, 404, p);
  }
});

test('console : aucune route de console sur un hôte d’espace ou neutre', async () => {
  const { b } = await enrolled();
  const tok = b.jar[pauth.COOKIE];
  for (const host of ['prime.localhost', 'localhost']) {
    const r = await H.request('GET', '/api/platform/me', { host, cookies: { [pauth.COOKIE]: tok } });
    assert.ok([401, 404].includes(r.status), host + ' ' + r.status);
    assert.ok(!r.body || !r.body.admin, 'aucune donnée de console');
  }
});

test('console : création d’administrateur uniquement par la CLI (aucune route web)', async () => {
  const { b } = await enrolled();
  for (const p of ['/api/platform/admins', '/api/platform/admin', '/api/platform/auth/register']) {
    const r = await b.post(p, { email: 'x@y.z', nom: 'X', password: PW });
    assert.equal(r.status, 404, p);
  }
  const anon = await H.request('POST', '/api/platform/admins', { host: ADMIN, headers: { 'X-DP-Console': '1', 'X-Forwarded-For': newIp() }, body: {} });
  assert.equal(anon.status, 401);
  // CLI : mot de passe faible refusé, mot de passe conforme accepté.
  const env = { ...process.env, DB_PATH: process.env.DB_PATH, DP_PLATFORM_CLI_MODE: 'create' };
  const cli = path.join(__dirname, '..', 'src', 'platform', 'cli.js');
  assert.throws(() => execFileSync(process.execPath, [cli, '--email', 'weak@delaipay.test', '--nom', 'W'], { env: { ...env, PLATFORM_ADMIN_PASSWORD: 'court1!' }, stdio: 'pipe' }));
  const out = execFileSync(process.execPath, [cli, '--email', 'cli@delaipay.test', '--nom', 'Cli Ops'], { env: { ...env, PLATFORM_ADMIN_PASSWORD: undefined }, stdio: 'pipe' }).toString();
  assert.match(out, /Administrateur plateforme créé : cli@delaipay\.test/);
  assert.match(out, /Mot de passe \(affiché une seule fois\) : \S{14,}/);
  assert.ok(db.prepare('SELECT 1 FROM platform_admin WHERE email=?').get('cli@delaipay.test'));
});

test('console : enrôlement 2FA obligatoire (QR local, codes de secours hachés, secret chiffré)', async () => {
  const email = newAdmin(); const b = consoleBrowser();
  let r = await b.post('/api/platform/auth/login', { email, password: PW });
  assert.equal(r.body.next, 'enrolement');
  // Avant l'enrôlement : aucune route protégée.
  assert.equal((await b.get('/api/platform/me')).status, 401);
  assert.equal((await b.get('/api/platform/audit')).status, 401);
  r = await b.get('/api/platform/auth/enrolment');
  assert.match(r.body.qrSvg, /^<svg[^>]+viewBox/);
  assert.match(r.body.uri, /^otpauth:\/\/totp\/DelaiPay/);
  const secret = r.body.secret.replace(/\s/g, '');
  assert.equal((await b.post('/api/platform/auth/enrolment', { code: '000000' })).status, 401, 'code faux refusé');
  r = await b.post('/api/platform/auth/enrolment', { code: totp.totp(secret) });
  assert.equal(r.status, 200);
  assert.equal(r.body.recoveryCodes.length, 10);
  const me = await b.get('/api/platform/me');
  assert.equal(me.status, 200); assert.equal(me.body.admin.email, email); assert.equal(me.body.admin.totpEnabled, true);
  assert.equal(me.body.fuseau, 'Africa/Casablanca', 'fuseau d’affichage de la console');
  const row = db.prepare('SELECT * FROM platform_admin WHERE email=?').get(email);
  assert.ok(!String(row.totp_secret_enc).includes(secret), 'secret TOTP chiffré au repos');
  assert.equal(store.open(row.totp_secret_enc), secret);
  const hashes = db.prepare('SELECT code_hash FROM platform_recovery_code WHERE admin_id=?').all(row.id).map(x => x.code_hash);
  assert.equal(hashes.length, 10);
  for (const c of r.body.recoveryCodes) assert.ok(!hashes.some(h => h.includes(c.replace('-', ''))), 'codes stockés hachés');
});

test('console : connexion suivante = mot de passe + TOTP ; rejeu du même code refusé', async () => {
  const { secret, email } = await enrolled();
  const b = consoleBrowser();
  let r = await b.post('/api/platform/auth/login', { email, password: PW });
  assert.equal(r.body.next, 'totp');
  assert.equal((await b.get('/api/platform/me')).status, 401, 'étape mfa : pas encore connecté');
  // Le code déjà utilisé lors de l'enrôlement (même pas de 30 s) est refusé : anti-rejeu.
  r = await b.post('/api/platform/auth/code', { code: totp.totp(secret) });
  assert.equal(r.status, 401);
  r = await b.post('/api/platform/auth/code', { code: totp.totp(secret, Date.now() + 30000) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await b.get('/api/platform/me')).status, 200);
});

test('console : code de secours à usage unique', async () => {
  const { codes, email } = await enrolled();
  const b1 = consoleBrowser();
  await b1.post('/api/platform/auth/login', { email, password: PW });
  let r = await b1.post('/api/platform/auth/code', { recoveryCode: codes[0].toUpperCase() });
  assert.equal(r.status, 200); assert.equal(r.body.recoveryCodesRemaining, 9);
  const b2 = consoleBrowser();
  await b2.post('/api/platform/auth/login', { email, password: PW });
  r = await b2.post('/api/platform/auth/code', { recoveryCode: codes[0] });
  assert.equal(r.status, 401, 'déjà utilisé');
});

test('console : erreurs génériques (compte inconnu = mot de passe faux) et étape limitée à 5 codes', async () => {
  const { email } = await enrolled();
  const a = await consoleBrowser().post('/api/platform/auth/login', { email: 'inconnu@delaipay.test', password: PW });
  const b = await consoleBrowser().post('/api/platform/auth/login', { email, password: 'Mauvais-mot-de-passe-1!' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.body, b.body, 'même réponse');
  const c = consoleBrowser();
  await c.post('/api/platform/auth/login', { email, password: PW });
  for (let i = 0; i < 5; i++) await c.post('/api/platform/auth/code', { code: '000000' });
  const r = await c.post('/api/platform/auth/code', { code: '111111' });
  assert.equal(r.body.code, 'etape_invalide', 'session d’étape close après 5 codes faux');
});

test('console : limitation de débit (5 essais / IP + e-mail) puis verrouillage du compte après 8 échecs', async () => {
  const { email, secret } = await enrolled();
  const b = consoleBrowser();
  for (let i = 0; i < 5; i++) assert.equal((await b.post('/api/platform/auth/login', { email, password: 'faux-' + i })).status, 401);
  assert.equal((await b.post('/api/platform/auth/login', { email, password: PW })).status, 429, '6e essai : limité');
  for (let i = 0; i < 3; i++) await consoleBrowser().post('/api/platform/auth/login', { email, password: 'faux-x' + i });
  const r = await consoleBrowser().post('/api/platform/auth/login', { email, password: PW });
  assert.equal(r.status, 401, 'compte verrouillé : même le bon mot de passe est refusé');
  assert.equal(r.body.error, pauth.GENERIC, 'message générique');
  assert.ok(db.prepare('SELECT verrouille_jusqua FROM platform_admin WHERE email=?').get(email).verrouille_jusqua);
  void secret;
});

test('console : délai d’inactivité et durée absolue de session', async () => {
  const { b } = await enrolled();
  assert.equal((await b.get('/api/platform/me')).status, 200);
  const sid = db.prepare('SELECT id FROM platform_session WHERE token_hash=?').get(store.sha256(b.jar[pauth.COOKIE])).id;
  db.prepare('UPDATE platform_session SET last_seen_at=? WHERE id=?').run(pauth.sqlTime(Date.now() - (pauth.IDLE_MIN + 1) * 60e3), sid);
  let r = await b.get('/api/platform/me');
  assert.equal(r.status, 401); assert.equal(r.body.code, 'session_expiree');
  const { b: b2 } = await enrolled();
  const sid2 = db.prepare('SELECT id FROM platform_session WHERE token_hash=?').get(store.sha256(b2.jar[pauth.COOKIE])).id;
  db.prepare('UPDATE platform_session SET expires_at=? WHERE id=?').run(pauth.sqlTime(Date.now() - 1000), sid2);
  r = await b2.get('/api/platform/me');
  assert.equal(r.status, 401); assert.equal(r.body.code, 'session_expiree');
  assert.ok(pauth.ABSOLUTE_H <= 12 && pauth.IDLE_MIN <= 30, 'sessions courtes');
});

test('console : cookie distinct, httpOnly, SameSite=Strict, limité à l’hôte (aucun Domain)', async () => {
  const email = newAdmin(); const b = consoleBrowser();
  const r = await b.post('/api/platform/auth/login', { email, password: PW });
  const c = r.setCookies[pauth.COOKIE];
  assert.ok(c, 'cookie console posé');
  assert.notEqual(pauth.COOKIE, auth.COOKIE);
  assert.ok(c.attrs.includes('httponly'));
  assert.ok(c.attrs.includes('samesite=strict'));
  assert.ok(c.attrs.includes('path=/'));
  assert.ok(!c.attrs.some(a => a.startsWith('domain=')), 'aucun attribut Domain');
  assert.ok(!('dp_token' in r.setCookies), 'aucun cookie d’espace');
});

test('console : écriture sans en-tête anti-CSRF ou d’une autre origine refusée', async () => {
  const { b } = await enrolled();
  let r = await b.post('/api/platform/auth/logout', {}, { headers: { 'X-DP-Console': '' } });
  assert.equal(r.status, 403);
  r = await b.post('/api/platform/auth/logout', {}, { headers: { Origin: 'http://prime.localhost' } });
  assert.equal(r.status, 403);
  assert.equal((await b.get('/api/platform/me')).status, 200, 'session intacte');
});

test('console : liste d’IP autorisées (CLI) — hors liste : 403 générique, même pour la page', async () => {
  store.setSetting('console_allowlist', [{ cidr: '203.0.113.0/24', label: 'Bureau' }], 'test');
  try {
    const out = await H.request('GET', '/', { host: ADMIN, headers: { 'X-Forwarded-For': '198.51.100.250' }, raw: true });
    assert.equal(out.status, 403); assert.equal(out.text, 'Accès refusé.');
    const api = await H.request('POST', '/api/platform/auth/login', { host: ADMIN, headers: { 'X-Forwarded-For': '198.51.100.250', 'X-DP-Console': '1' }, body: { email: 'x', password: 'y' } });
    assert.equal(api.status, 403);
    const inList = await H.request('GET', '/', { host: ADMIN, headers: { 'X-Forwarded-For': '203.0.113.9' }, raw: true });
    assert.equal(inList.status, 200);
    // Les espaces ne sont pas concernés.
    const ws = await H.request('GET', '/api/tenant', { host: 'prime.localhost', headers: { 'X-Forwarded-For': '198.51.100.250' } });
    assert.equal(ws.status, 200);
  } finally { store.setSetting('console_allowlist', [], 'test'); }
});

test('console : journal plateforme en lecture seule (ni UPDATE ni DELETE) et complet', async () => {
  const { email, b } = await enrolled();
  const rows = (await b.get('/api/platform/audit?limit=500')).body.rows;
  const mine = rows.filter(r => r.admin_email === email);
  assert.ok(mine.some(r => r.action === 'enrolement_2fa'));
  assert.ok(mine.some(r => r.action === 'connexion_console' && r.ip && r.ip.startsWith('198.51.100.')), 'IP réelle (proxy de confiance)');
  assert.ok(rows.some(r => r.action === 'connexion_console_refusee'));
  assert.throws(() => db.prepare('UPDATE platform_audit SET action=?').run('x'), /lecture seule/);
  assert.throws(() => db.prepare('DELETE FROM platform_audit').run(), /lecture seule/);
  assert.equal((await b.del('/api/platform/audit')).status, 404, 'aucune route de suppression');
});

test('séparation : une session d’espace n’ouvre jamais la console, et inversement', async () => {
  const w = workspace.createWorkspace({ slug: 'sepa', nom: 'Sépa', admin: { email: 'admin@sepa.ma', nom: 'A', password: 'Secret-1234' } });
  const tenantJwt = auth.signToken(db.prepare('SELECT * FROM utilisateur WHERE id=?').get(w.userId));
  // Jeton d'espace valide présenté à la console (sous son propre nom de cookie, ou sous celui de la console).
  for (const cookies of [{ dp_token: tenantJwt }, { [pauth.COOKIE]: tenantJwt }]) {
    const r = await H.request('GET', '/api/platform/me', { host: ADMIN, cookies, headers: { 'X-Forwarded-For': newIp() } });
    assert.equal(r.status, 401);
  }
  const ok = await H.request('GET', '/api/me', { host: 'sepa.localhost', cookies: { dp_token: tenantJwt } });
  assert.equal(ok.status, 200, 'le jeton est bien valide sur son espace');
  // Jeton de console valide présenté à un espace.
  const { b } = await enrolled();
  const ctok = b.jar[pauth.COOKIE];
  for (const cookies of [{ dp_token: ctok }, { [pauth.COOKIE]: ctok }]) {
    const r = await H.request('GET', '/api/me', { host: 'sepa.localhost', cookies });
    assert.equal(r.status, 401);
  }
  const page = await H.request('GET', '/', { host: 'sepa.localhost', cookies: { [pauth.COOKIE]: ctok }, raw: true });
  assert.equal(page.status, 302, 'page d’espace : redirection vers la connexion');
});

test('console : déconnexion ferme la session côté serveur', async () => {
  const { b } = await enrolled();
  const tok = b.jar[pauth.COOKIE];
  assert.equal((await b.post('/api/platform/auth/logout', {})).status, 200);
  const r = await H.request('GET', '/api/platform/me', { host: ADMIN, cookies: { [pauth.COOKIE]: tok }, headers: { 'X-Forwarded-For': newIp() } });
  assert.equal(r.status, 401, 'le jeton rejoué après déconnexion est refusé');
});
