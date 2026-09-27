'use strict';
/* INC 3A — Phases 4 & 5 : appareils, sessions, politique d'accès (appareils approuvés, liste d'IP, IP bloquées).
 * Proxy de confiance local (TRUST_PROXY=loopback) : chaque navigateur simulé présente l'IP de son choix. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_access_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} } });
process.env.TRUST_PROXY = 'loopback';

const H = require('./helpers/http');
const { consoleSession, createWs, acceptAdmin } = require('./helpers/console');
const { db } = require('../src/db');
const devices = require('../src/devices');
after(() => H.stop());

const PW = 'Secret-1234';
const MSG_PENDING = 'Cet appareil doit être approuvé par l’administrateur de votre espace.';
let C; const con = async () => (C = C || await consoleSession());
const nav = (host, ip, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/128.0') => H.browser(host, { headers: { 'X-Forwarded-For': ip, 'User-Agent': ua } });
let n = 0;
async function team() {
  const slug = 'acc' + (++n);
  const c = await con();
  const w = await createWs(c, slug);
  const admin = await acceptAdmin(w, { browser: nav(`${slug}.localhost`, '203.0.113.10') });
  const inv = await admin.post('/api/invitations', { email: `compta@${slug}.ma`, role: 'collaborateur' });
  const token = inv.body.invitation.token;
  const compta = nav(`${slug}.localhost`, '198.51.100.20');
  assert.equal((await compta.post('/api/invitations/accept', { token, nom: 'Comptable', password: PW })).status, 200);
  return { c, w, slug, host: `${slug}.localhost`, admin, compta, comptaEmail: `compta@${slug}.ma` };
}
const devOf = (b) => Object.keys(b.jar).filter(k => k.startsWith('dp_dev_'));
const deviceIdByUser = email => db.prepare('SELECT d.id FROM device d JOIN utilisateur u ON u.id=d.user_id WHERE u.email=? ORDER BY d.first_seen DESC, d.rowid DESC LIMIT 1').get(email).id;

test('appareils : enregistrés à la connexion (cookie httpOnly lié à l’utilisateur, modèle via Sec-CH-UA-Model uniquement)', async () => {
  const t = await team();
  const b = H.browser(t.host, { headers: { 'X-Forwarded-For': '198.51.100.77', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile', 'Sec-CH-UA-Model': '"Pixel 8"', 'Sec-CH-UA-Mobile': '?1', 'Sec-CH-UA-Platform': '"Android"' } });
  const r = await b.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  assert.equal(r.status, 200);
  const name = Object.keys(r.setCookies).find(k => k.startsWith('dp_dev_'));
  assert.ok(name, 'cookie d’appareil posé');
  const attrs = r.setCookies[name].attrs;
  assert.ok(attrs.includes('httponly') && attrs.includes('samesite=lax') && !attrs.some(a => a.startsWith('domain=')));
  const d = db.prepare('SELECT * FROM device WHERE id=?').get(deviceIdByUser(t.comptaEmail));
  assert.equal(d.statut, 'connu'); assert.equal(d.modele, 'Pixel 8'); assert.equal(d.type_appareil, 'mobile'); assert.equal(d.os, 'Android');
  assert.equal(d.derniere_ip, '198.51.100.77');
  assert.ok(!JSON.stringify(d).includes(r.setCookies[name].value), 'jeton stocké haché');
  const page = await H.request('GET', '/login', { host: t.host, raw: true });
  assert.match(page.headers['accept-ch'] || '', /Sec-CH-UA-Model/);
});

test('appareils approuvés : activation depuis l’espace (appareil courant auto-approuvé), inconnu → en attente → approuvé', async () => {
  const t = await team();
  const p = await t.admin.put('/api/security/policy', { appareils: true });
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.approuves, 1);
  assert.equal((await t.admin.get('/api/me')).status, 200, 'protection anti-blocage : l’administrateur reste connecté');
  // La session du comptable (appareil « connu », non approuvé) est coupée à la requête suivante.
  const cut = await t.compta.get('/api/me');
  assert.equal(cut.status, 401); assert.equal(cut.body.reason, 'appareil_en_attente');
  const fresh = nav(t.host, '198.51.100.21');
  const r = await fresh.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'appareil_en_attente'); assert.equal(r.body.error, MSG_PENDING);
  const sec = (await t.admin.get('/api/security')).body;
  const pending = sec.appareils.filter(d => d.statut === 'en_attente' && d.utilisateur.email === t.comptaEmail);
  assert.ok(pending.length >= 1);
  const did = deviceIdByUser(t.comptaEmail);
  assert.equal((await t.admin.post(`/api/security/devices/${did}/approve`)).status, 200);
  assert.equal((await fresh.post('/api/auth/login', { email: t.comptaEmail, password: PW })).status, 200, 'approuvé : connexion');
  assert.equal((await fresh.get('/api/me')).status, 200);
  const wa = (await t.admin.get('/api/audit')).body.map(x => x.action);
  assert.ok(wa.includes('politique_acces') && wa.includes('appareil_approuve'), 'journal de l’espace');
  const pa = (await t.c.get(`/api/platform/audit?type=espace&cible=${t.w.id}`)).body.rows.map(x => x.action);
  assert.ok(pa.includes('politique_acces') && pa.includes('appareil_approuve'), 'journal de la plateforme');
});

test('appareils approuvés : refusé → connexion refusée ; révoqué → sessions fermées, nouvelle demande', async () => {
  const t = await team();
  await t.admin.put('/api/security/policy', { appareils: true });
  const b = nav(t.host, '198.51.100.30');
  await b.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  let did = deviceIdByUser(t.comptaEmail);
  assert.equal((await t.admin.post(`/api/security/devices/${did}/refuse`)).status, 200);
  const refused = await b.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  assert.equal(refused.status, 403); assert.equal(refused.body.code, 'appareil_refuse');
  const b2 = nav(t.host, '198.51.100.31');
  await b2.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  did = deviceIdByUser(t.comptaEmail);
  await t.admin.post(`/api/security/devices/${did}/approve`);
  assert.equal((await b2.post('/api/auth/login', { email: t.comptaEmail, password: PW })).status, 200);
  assert.equal((await b2.get('/api/me')).status, 200);
  const rv = await t.admin.post(`/api/security/devices/${did}/revoke`);
  assert.equal(rv.status, 200); assert.equal(rv.body.sessions, 1);
  const after = await b2.get('/api/me');
  assert.equal(after.status, 401); assert.equal(after.body.reason, 'appareil_revoque');
  const again = await b2.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  assert.equal(again.body.code, 'appareil_en_attente', 'appareil révoqué : nouvelle approbation nécessaire');
  // L'administrateur ne peut pas révoquer son propre appareil courant.
  const own = (await t.admin.get('/api/security')).body.appareilCourant;
  assert.equal((await t.admin.post(`/api/security/devices/${own}/revoke`)).status, 400);
});

test('appareils approuvés : le changement d’IP n’affecte pas un appareil approuvé', async () => {
  const t = await team();
  await t.admin.put('/api/security/policy', { appareils: true });
  const at = ip => H.browser(t.host, { headers: { 'X-Forwarded-For': ip } });
  const b = at('198.51.100.40'); const jar = b.jar;
  await b.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  await t.admin.post(`/api/security/devices/${deviceIdByUser(t.comptaEmail)}/approve`);
  assert.equal((await b.post('/api/auth/login', { email: t.comptaEmail, password: PW })).status, 200);
  for (const ip of ['203.0.113.99', '192.0.2.45', '2001:db8::7']) {
    const hop = at(ip); Object.assign(hop.jar, jar);
    assert.equal((await hop.get('/api/me')).status, 200, 'requête depuis ' + ip);
  }
  const other = at('192.0.2.200'); Object.assign(other.jar, Object.fromEntries(Object.entries(jar).filter(([k]) => k.startsWith('dp_dev_'))));
  assert.equal((await other.post('/api/auth/login', { email: t.comptaEmail, password: PW })).status, 200, 'nouvelle connexion depuis une autre IP : appareil reconnu');
  assert.equal(db.prepare('SELECT derniere_ip FROM device WHERE id=?').get(deviceIdByUser(t.comptaEmail)).derniere_ip, '192.0.2.200');
});

test('appareils : un jeton d’appareil est lié à son utilisateur (copié sur un autre compte → inconnu)', async () => {
  const t = await team();
  await t.admin.put('/api/security/policy', { appareils: true });
  const b = nav(t.host, '198.51.100.50');
  await b.post('/api/auth/login', { email: t.comptaEmail, password: PW });
  await t.admin.post(`/api/security/devices/${deviceIdByUser(t.comptaEmail)}/approve`);
  const tok = b.jar[devOf(b)[0]];
  const adminId = db.prepare('SELECT id FROM utilisateur WHERE email=?').get(`admin@${t.slug}.ma`).id;
  const thief = nav(t.host, '198.51.100.51');
  thief.jar[devices.cookieName(adminId)] = tok;
  const r = await thief.post('/api/auth/login', { email: `admin@${t.slug}.ma`, password: PW });
  assert.equal(r.status, 403); assert.equal(r.body.code, 'appareil_en_attente');
});

test('liste d’IP autorisées : vérifiée à la connexion et à chaque requête ; l’espace refuse une liste qui bloquerait l’administrateur', async () => {
  const t = await team();
  const bad = await t.admin.put('/api/security/policy', { ipAutorisees: true, listeIp: [{ cidr: '192.0.2.0/24', label: 'Autre' }] });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'auto_blocage');
  const ok = await t.admin.put('/api/security/policy', { ipAutorisees: true, listeIp: [{ cidr: '203.0.113.0/24', label: 'Bureau Casablanca' }] });
  assert.equal(ok.status, 200);
  assert.equal((await t.admin.get('/api/me')).status, 200);
  const cut = await t.compta.get('/api/me');   // comptable connecté depuis 198.51.100.20
  assert.equal(cut.status, 401); assert.equal(cut.body.reason, 'ip_non_autorisee');
  const out = await nav(t.host, '198.51.100.20').post('/api/auth/login', { email: t.comptaEmail, password: PW });
  assert.equal(out.status, 403); assert.equal(out.body.code, 'ip_non_autorisee');
  const inside = nav(t.host, '203.0.113.55');
  assert.equal((await inside.post('/api/auth/login', { email: t.comptaEmail, password: PW })).status, 200);
  // Requête ultérieure depuis une IP hors liste avec la même session : refusée.
  const moved = nav(t.host, '192.0.2.9'); Object.assign(moved.jar, inside.jar);
  assert.equal((await moved.get('/api/me')).status, 401);
  assert.ok(db.prepare(`SELECT 1 FROM login_event WHERE email=? AND resultat='bloque_politique'`).get(t.comptaEmail), 'activité de connexion');
});

test('modes combinés : appareils approuvés + liste d’IP', async () => {
  const t = await team();
  assert.equal((await t.admin.put('/api/security/policy', { appareils: true, ipAutorisees: true, listeIp: ['203.0.113.0/24'] })).status, 200);
  const b = nav(t.host, '203.0.113.60');
  assert.equal((await b.post('/api/auth/login', { email: t.comptaEmail, password: PW })).body.code, 'appareil_en_attente');
  await t.admin.post(`/api/security/devices/${deviceIdByUser(t.comptaEmail)}/approve`);
  assert.equal((await b.post('/api/auth/login', { email: t.comptaEmail, password: PW })).status, 200);
  const outside = nav(t.host, '198.51.100.60'); Object.assign(outside.jar, b.jar);
  assert.equal((await outside.post('/api/auth/login', { email: t.comptaEmail, password: PW })).body.code, 'ip_non_autorisee', 'appareil approuvé mais réseau non autorisé');
});

test('IP bloquées : par espace et globale (console)', async () => {
  const t = await team();
  assert.equal((await t.admin.put('/api/security/policy', { ipBloquees: [{ cidr: '198.51.100.20', label: 'Poste perdu' }] })).status, 200);
  assert.equal((await t.compta.get('/api/me')).body.reason, 'ip_bloquee');
  assert.equal((await nav(t.host, '198.51.100.20').post('/api/auth/login', { email: t.comptaEmail, password: PW })).body.code, 'ip_bloquee');
  assert.equal((await nav(t.host, '198.51.100.21').post('/api/auth/login', { email: t.comptaEmail, password: PW })).status, 200);
  const selfBlock = await t.admin.put('/api/security/policy', { ipBloquees: ['203.0.113.10'] });
  assert.equal(selfBlock.status, 400, 'on ne bloque pas sa propre IP');
  const t2 = await team();
  assert.equal((await t.c.put('/api/platform/ip-blocklist', { rows: [{ cidr: '192.0.2.128/25', label: 'Plage abusive' }] })).status, 200);
  try {
    for (const tt of [t, t2]) assert.equal((await nav(tt.host, '192.0.2.200').post('/api/auth/login', { email: tt.comptaEmail, password: PW })).body.code, 'ip_bloquee');
    const pa = (await t.c.get('/api/platform/audit')).body.rows.find(r => r.action === 'ip_bloquees_globales');
    assert.ok(pa && pa.apres.length === 1);
  } finally { await t.c.put('/api/platform/ip-blocklist', { rows: [] }); }
});

test('console : politique d’un espace (avertissement IP des administrateurs), appareils et sessions, révocation', async () => {
  const t = await team();
  const r = await t.c.put(`/api/platform/workspaces/${t.w.id}/security/policy`, { ipAutorisees: true, listeIp: ['192.0.2.0/24'] });
  assert.equal(r.status, 200);
  assert.ok(r.body.avertissements.some(a => a.includes(`admin@${t.slug}.ma`)), 'avertit : IP de l’administrateur hors liste');
  assert.equal((await t.c.put(`/api/platform/workspaces/${t.w.id}/security/policy`, { ipAutorisees: false, appareils: true, approuverAppareilsConnus: true })).status, 200);
  const sec = (await t.c.get(`/api/platform/workspaces/${t.w.id}/security`)).body;
  assert.equal(sec.mode, 'Appareils approuvés');
  assert.ok(sec.appareils.length >= 2 && sec.appareils.every(d => d.statut === 'approuve'), 'appareils connus approuvés à l’activation');
  assert.equal((await t.compta.get('/api/me')).status, 200, 'aucun blocage des appareils connus');
  const s = (await t.c.get(`/api/platform/sessions?cabinet=${t.w.id}`)).body.rows.find(x => x.utilisateur.email === t.comptaEmail);
  assert.ok(s && s.navigateur && s.ipDerniere);
  assert.equal((await t.c.post(`/api/platform/sessions/${s.id}/revoke`, {})).status, 200);
  assert.equal((await t.compta.get('/api/me')).body.reason, 'deconnexion_forcee');
  const did = deviceIdByUser(t.comptaEmail);
  assert.equal((await t.c.post(`/api/platform/devices/${did}/revoke`, {})).status, 200);
  assert.equal((await t.c.get(`/api/platform/devices?cabinet=${t.w.id}&statut=revoque`)).body.rows.length, 1);
  const wa = (await t.admin.get('/api/audit')).body;
  assert.ok(wa.some(x => x.action === 'appareil_revoque' && /Équipe DelaiPay/.test(x.user_nom || '')), 'visible côté espace');
});

test('invitation acceptée sous « appareils approuvés » : compte créé, connexion en attente d’approbation', async () => {
  const t = await team();
  await t.admin.put('/api/security/policy', { appareils: true });
  const inv = await t.admin.post('/api/invitations', { email: `nouveau@${t.slug}.ma`, role: 'lecture' });
  const b = nav(t.host, '198.51.100.80');
  const r = await b.post('/api/invitations/accept', { token: inv.body.invitation.token, nom: 'Nouveau', password: PW });
  assert.equal(r.status, 200); assert.equal(r.body.loginRequired, true); assert.equal(r.body.message, MSG_PENDING);
  assert.ok(!b.jar.dp_token, 'aucune session ouverte');
});
