'use strict';
/* INC 3A — Phase 7 : accès d'assistance (motif, ≤ 2 h, lecture seule, visible dans l'espace, fin automatique). */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_psupport_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} } });
process.env.TRUST_PROXY = 'loopback';

const H = require('./helpers/http');
const { consoleSession, createWs, acceptAdmin } = require('./helpers/console');
const { db } = require('../src/db');
const support = require('../src/support-access');
after(() => H.stop());

let C; const con = async () => (C = C || await consoleSession());
let n = 0;
async function setup() {
  const c = await con();
  const slug = 'sup' + (++n);
  const w = await createWs(c, slug);
  const admin = await acceptAdmin(w);
  await admin.post('/api/clients', { raison_sociale: 'CLIENT VISIBLE EN ASSISTANCE' });
  return { c, w, slug, host: `${slug}.localhost`, admin };
}
async function openSupport(t, body = { motif: 'Ticket 42 — écart de total T1', dureeMinutes: 30 }) {
  const r = await t.c.post(`/api/platform/workspaces/${t.w.id}/support`, body);
  return r;
}
const tokenOf = lien => lien.split('#t=')[1];

test('assistance : motif obligatoire, 2 h au maximum, lien vers l’hôte de l’espace', async () => {
  const t = await setup();
  assert.equal((await openSupport(t, { motif: '', dureeMinutes: 30 })).status, 400);
  assert.equal((await openSupport(t, { motif: 'Diagnostic', dureeMinutes: 121 })).status, 400);
  assert.equal((await openSupport(t, { motif: 'Diagnostic', dureeMinutes: 600 })).status, 400);
  const r = await openSupport(t);
  assert.equal(r.status, 200);
  assert.match(r.body.lien, new RegExp(`^http://${t.slug}\\.localhost(:\\d+)?/support#t=[\\w-]{40,}$`));
  assert.equal((await openSupport(t)).status, 409, 'un seul accès en cours par administrateur et espace');
});

test('assistance : session en lecture seule stricte, lien à usage unique et lié à l’espace', async () => {
  const t = await setup(); const other = await setup();
  const r = await openSupport(t);
  const token = tokenOf(r.body.lien);
  assert.equal((await H.request('POST', '/api/support/exchange', { host: other.host, body: { token } })).status, 410, 'autre espace : refusé');
  const b = H.browser(t.host);
  assert.equal((await b.post('/api/support/exchange', { token })).status, 200);
  assert.equal((await H.browser(t.host).post('/api/support/exchange', { token })).status, 410, 'usage unique');
  const me = await b.get('/api/me');
  assert.equal(me.status, 200); assert.equal(me.body.user.role, 'lecture'); assert.match(me.body.user.nom, /Assistance DelaiPay/);
  assert.equal(me.body.plateforme.support.motif, 'Ticket 42 — écart de total T1');
  const clients = await b.get('/api/clients');
  assert.equal(clients.status, 200); assert.ok(clients.body.some(x => x.name === 'CLIENT VISIBLE EN ASSISTANCE'));
  for (const [m, p, body] of [['POST', '/api/clients', { raison_sociale: 'X' }], ['PUT', '/api/me/password', { current: 'x', next: 'Autre-mdp-123' }], ['PUT', '/api/workspace', { nomAffiche: 'X' }], ['POST', '/api/invitations', { email: 'x@y.ma', role: 'admin' }]]) {
    const w = await b.req(m, p, body);
    assert.equal(w.status, 403, `${m} ${p}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=?').get(t.w.id).n, 1, 'aucun compte créé dans l’espace');
  // La session d'assistance n'ouvre pas la console.
  assert.equal((await H.request('GET', '/api/platform/me', { host: 'admin.localhost', cookies: { dp_token: b.jar.dp_token }, headers: { 'X-Forwarded-For': '192.0.2.99' } })).status, 401);
});

test('assistance : visible dans le journal de l’espace et dans Paramètres → Sécurité ; journal plateforme', async () => {
  const t = await setup();
  const r = await openSupport(t);
  const b = H.browser(t.host); await b.post('/api/support/exchange', { token: tokenOf(r.body.lien) });
  const wa = (await t.admin.get('/api/audit')).body;
  const opened = wa.find(x => x.action === 'acces_support_ouvert');
  assert.ok(opened && /Assistance DelaiPay/.test(opened.user_nom) && /Ticket 42/.test(opened.details));
  assert.ok(wa.some(x => x.action === 'acces_support_utilise'));
  const sec = (await t.admin.get('/api/security')).body;
  assert.equal(sec.supports.length, 1); assert.equal(sec.supports[0].actif, true); assert.equal(sec.supports[0].admin, t.c.email);
  assert.ok(sec.sessions.some(s => s.type === 'support'), 'session d’assistance listée');
  const pa = (await t.c.get(`/api/platform/audit?type=espace&cible=${t.w.id}`)).body.rows;
  assert.ok(pa.some(x => x.action === 'acces_support_ouvert' && x.details.lecture_seule === true));
});

test('assistance : fin manuelle et fin automatique (sessions fermées, journal de l’espace)', async () => {
  const t = await setup();
  let r = await openSupport(t);
  const b = H.browser(t.host); await b.post('/api/support/exchange', { token: tokenOf(r.body.lien) });
  assert.equal((await t.c.post(`/api/platform/support/${r.body.id}/end`, {})).status, 200);
  let me = await b.get('/api/me');
  assert.equal(me.status, 401); assert.equal(me.body.reason, 'fin_support');
  r = await openSupport(t, { motif: 'Second diagnostic', dureeMinutes: 15 });
  const b2 = H.browser(t.host); await b2.post('/api/support/exchange', { token: tokenOf(r.body.lien) });
  assert.equal((await b2.get('/api/me')).status, 200);
  db.prepare(`UPDATE support_access SET fin=datetime('now','-1 minutes') WHERE id=?`).run(r.body.id);
  me = await b2.get('/api/me');
  assert.equal(me.status, 401);
  support.sweep();
  const wa = (await t.admin.get('/api/audit')).body.filter(x => x.action === 'acces_support_termine');
  assert.equal(wa.length, 2);
  assert.ok(wa.some(x => /durée écoulée/.test(x.details)), 'fin automatique tracée');
  assert.equal((await t.c.get('/api/platform/support/active')).body.rows.filter(a => a.espace.id === t.w.id).length, 0);
});
