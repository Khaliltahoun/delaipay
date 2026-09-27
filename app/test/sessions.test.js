'use strict';
/* INC 3A — Sessions d'espace côté serveur, appareils, politique d'accès. Aucun proxy de confiance ici :
 * un X-Forwarded-For envoyé par le client DOIT être ignoré. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const jwt = require('jsonwebtoken');

process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_sessions_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} } });
delete process.env.TRUST_PROXY;

const H = require('./helpers/http');
const { db } = require('../src/db');
const workspace = require('../src/workspace');
const sessions = require('../src/sessions');
const auth = require('../src/auth');
after(() => H.stop());

const PW = 'Secret-1234';
let n = 0;
function ws(slug = 'ses' + (++n)) {
  const w = workspace.createWorkspace({ slug, nom: 'Cabinet ' + slug, admin: { email: `admin@${slug}.ma`, nom: 'Admin ' + slug, password: PW } });
  return { ...w, host: `${slug}.localhost`, email: `admin@${slug}.ma` };
}
async function login(w, b = H.browser(w.host, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36' } }), email = w.email) {
  const r = await b.post('/api/auth/login', { email, password: PW });
  return { b, r };
}

test('sessions : la connexion ouvre une session serveur (IP, navigateur, système) ; la déconnexion la ferme', async () => {
  const w = ws();
  const { b, r } = await login(w);
  assert.equal(r.status, 200);
  const tok = b.jar.dp_token;
  const sid = jwt.decode(tok).sid;
  const s = sessions.get(sid);
  assert.ok(s && !s.ended_at);
  assert.equal(s.user_id, w.userId); assert.equal(s.cabinet_id, w.cabinetId);
  assert.equal(s.navigateur, 'Chrome 128'); assert.equal(s.os, 'Windows'); assert.equal(s.type_appareil, 'ordinateur');
  assert.equal(s.modele, null, 'modèle jamais deviné');
  assert.equal((await b.get('/api/me')).status, 200);
  await b.post('/api/auth/logout');
  const replay = await H.request('GET', '/api/me', { host: w.host, cookies: { dp_token: tok } });
  assert.equal(replay.status, 401, 'jeton rejoué après déconnexion : refusé');
  assert.ok(sessions.get(sid).ended_at);
});

test('sessions : jeton correctement signé mais sans session enregistrée refusé', async () => {
  const w = ws();
  const u = db.prepare('SELECT * FROM utilisateur WHERE id=?').get(w.userId);
  // Même avec la bonne signature : un sid inexistant est refusé.
  const forged = auth.signToken(u, { sid: 'ses_inexistante' });
  const r2 = await H.request('GET', '/api/me', { host: w.host, cookies: { dp_token: forged } });
  assert.equal(r2.status, 401); assert.equal(r2.body.code, 'expired_stale');
});

test('sessions : fin forcée côté serveur → 401 avec le motif lisible', async () => {
  const w = ws();
  const { b } = await login(w);
  const sid = jwt.decode(b.jar.dp_token).sid;
  sessions.end(sid, 'deconnexion_forcee');
  const r = await b.get('/api/me');
  assert.equal(r.status, 401); assert.equal(r.body.reason, 'deconnexion_forcee');
  assert.match(r.body.error, /fermée par un administrateur/);
  const page = await H.request('GET', '/', { host: w.host, cookies: { dp_token: jwt.sign({}, 'x') }, raw: true });
  assert.equal(page.status, 302);
});

test('réseau : X-Forwarded-For forgé ignoré sans proxy de confiance (IP de connexion enregistrée)', async () => {
  const w = ws();
  const b = H.browser(w.host, { headers: { 'X-Forwarded-For': '203.0.113.66' } });
  const { r } = await login(w, b);
  assert.equal(r.status, 200);
  const s = sessions.get(jwt.decode(b.jar.dp_token).sid);
  assert.notEqual(s.ip, '203.0.113.66');
  assert.equal(s.ip, '127.0.0.1');
  assert.ok(!db.prepare(`SELECT 1 FROM audit_log WHERE ip LIKE '%203.0.113.66%'`).get(), 'jamais dans le journal');
});

test('réseau : X-Forwarded-For forgé ne contourne ni la liste d’IP autorisées ni les IP bloquées', async () => {
  const w = ws();
  db.prepare('UPDATE cabinet SET acces_json=? WHERE id=?').run(JSON.stringify({ ipAutorisees: true, listeIp: [{ cidr: '203.0.113.0/24', label: 'Bureau' }] }), w.cabinetId);
  const spoof = H.browser(w.host, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
  const r = await spoof.post('/api/auth/login', { email: w.email, password: PW });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'ip_non_autorisee', 'l’IP réelle (127.0.0.1) est hors liste');
  db.prepare('UPDATE cabinet SET acces_json=? WHERE id=?').run(JSON.stringify({ ipBloquees: [{ cidr: '127.0.0.1', label: 'test' }] }), w.cabinetId);
  const spoof2 = H.browser(w.host, { headers: { 'X-Forwarded-For': '198.51.100.1' } });
  assert.equal((await spoof2.post('/api/auth/login', { email: w.email, password: PW })).body.code, 'ip_bloquee', 'le XFF ne masque pas l’IP bloquée');
  db.prepare('UPDATE cabinet SET acces_json=NULL WHERE id=?').run(w.cabinetId);
});
