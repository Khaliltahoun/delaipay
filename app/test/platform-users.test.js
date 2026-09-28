'use strict';
/* INC 3A — Phase 3 : utilisateurs d'un espace depuis la console. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_pusers_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} } });
process.env.TRUST_PROXY = 'loopback';

const H = require('./helpers/http');
const { consoleSession, createWs, acceptAdmin } = require('./helpers/console');
const { db } = require('../src/db');
after(() => H.stop());

const PW = 'Secret-1234';
let C; const con = async () => (C = C || await consoleSession());
async function wsWithTeam(slug) {
  const c = await con();
  const w = await createWs(c, slug);
  const admin = await acceptAdmin(w);
  const inv = await admin.post('/api/invitations', { email: `compta@${slug}.ma`, role: 'collaborateur' });
  const compta = H.browser(`${slug}.localhost`);
  assert.equal((await compta.post('/api/invitations/accept', { token: inv.body.invitation.token, nom: 'Comptable', password: PW })).status, 200);
  const users = (await c.get(`/api/platform/workspaces/${w.id}/users`)).body.rows;
  return { c, w, admin, compta, adminU: users.find(u => u.role === 'admin'), comptaU: users.find(u => u.role === 'collaborateur') };
}

test('utilisateurs : liste avec rôle, statut, création, dernière connexion, sessions (aucune donnée métier)', async () => {
  const { c, w } = await wsWithTeam('usr1');
  const d = (await c.get(`/api/platform/workspaces/${w.id}/users`)).body;
  assert.equal(d.rows.length, 2);
  for (const u of d.rows) {
    assert.ok(u.email && u.role && u.created_at && 'derniere_connexion' in u && 'appareils' in u);
    assert.ok(!('password_hash' in u));
    assert.equal(u.sessionsActives, 1);
  }
});

test('utilisateurs : désactivation (sessions fermées), réactivation, changement de rôle — journalisés des deux côtés', async () => {
  const { c, w, compta, admin, comptaU } = await wsWithTeam('usr2');
  const base = `/api/platform/workspaces/${w.id}/users/${comptaU.id}`;
  assert.equal((await c.patch(base, { actif: false })).status, 200);
  const me = await compta.get('/api/me');
  assert.equal(me.status, 401); assert.match(me.body.error, /désactivé/);
  assert.equal((await c.patch(base, { actif: true })).status, 200);
  assert.equal((await c.patch(base, { role: 'lecture' })).status, 200);
  const relog = H.browser('usr2.localhost');
  assert.equal((await relog.post('/api/auth/login', { email: 'compta@usr2.ma', password: PW })).status, 200);
  assert.equal((await relog.get('/api/me')).body.user.role, 'lecture');
  const pa = (await c.get(`/api/platform/audit?type=espace&cible=${w.id}`)).body.rows;
  assert.ok(pa.some(r => r.action === 'utilisateur_desactive' && r.avant.actif === true && r.apres.actif === false));
  assert.ok(pa.some(r => r.action === 'utilisateur_modifie' && r.avant.role === 'collaborateur' && r.apres.role === 'lecture'));
  const wa = (await admin.get('/api/audit')).body;
  assert.ok(wa.some(r => r.entite === 'utilisateur' && /Équipe DelaiPay/.test(r.user_nom || '')), 'visible dans le journal de l’espace');
});

test('utilisateurs : le dernier administrateur actif est protégé', async () => {
  const { c, w, adminU } = await wsWithTeam('usr3');
  const base = `/api/platform/workspaces/${w.id}/users/${adminU.id}`;
  const r1 = await c.patch(base, { actif: false });
  assert.equal(r1.status, 400); assert.match(r1.body.error, /au moins un administrateur actif/);
  const r2 = await c.patch(base, { role: 'lecture' });
  assert.equal(r2.status, 400);
  assert.equal(db.prepare('SELECT role, actif FROM utilisateur WHERE id=?').get(adminU.id).role, 'admin');
});

test('utilisateurs : déconnexion forcée ferme toutes les sessions de l’utilisateur', async () => {
  const { c, w, admin, adminU } = await wsWithTeam('usr4');
  const second = H.browser('usr4.localhost');
  await second.post('/api/auth/login', { email: 'admin@usr4.ma', password: PW });
  const r = await c.post(`/api/platform/workspaces/${w.id}/users/${adminU.id}/logout`, {});
  assert.equal(r.status, 200); assert.equal(r.body.sessionsFermees, 2);
  for (const b of [admin, second]) { const me = await b.get('/api/me'); assert.equal(me.status, 401); assert.equal(me.body.reason, 'deconnexion_forcee'); }
  const again = H.browser('usr4.localhost');
  assert.equal((await again.post('/api/auth/login', { email: 'admin@usr4.ma', password: PW })).status, 200, 'peut se reconnecter');
});

test('utilisateurs : lien de réinitialisation à usage unique, montré une fois, lié à l’espace', async () => {
  const { c, w, compta, comptaU } = await wsWithTeam('usr5');
  const r = await c.post(`/api/platform/workspaces/${w.id}/users/${comptaU.id}/reset-link`, {});
  assert.equal(r.status, 200);
  assert.match(r.body.lien, /^http:\/\/usr5\.localhost(:\d+)?\/reset#t=[\w-]{40,}$/);
  const token = r.body.lien.split('#t=')[1];
  assert.ok(!db.prepare('SELECT 1 FROM password_reset WHERE token_hash=?').get(token), 'jeton stocké haché');
  const pa = (await c.get(`/api/platform/audit?type=espace&cible=${w.id}`)).body.rows.find(x => x.action === 'lien_reinitialisation');
  assert.ok(pa && !JSON.stringify(pa).includes(token), 'jamais journalisé');
  // Autre espace : refusé.
  assert.equal((await H.request('POST', '/api/password-reset/lookup', { host: 'usr4.localhost', body: { token } })).status, 410);
  const look = await H.request('POST', '/api/password-reset/lookup', { host: 'usr5.localhost', body: { token } });
  assert.equal(look.status, 200); assert.equal(look.body.email, 'compta@usr5.ma');
  assert.equal((await H.request('POST', '/api/password-reset/complete', { host: 'usr5.localhost', body: { token, password: 'court' } })).status, 400);
  const done = await H.request('POST', '/api/password-reset/complete', { host: 'usr5.localhost', body: { token, password: 'Nouveau-Mdp-2026' } });
  assert.equal(done.status, 200);
  assert.equal((await compta.get('/api/me')).status, 401, 'sessions fermées');
  assert.equal((await H.request('POST', '/api/password-reset/complete', { host: 'usr5.localhost', body: { token, password: 'Autre-Mdp-2026' } })).status, 410, 'usage unique');
  assert.equal((await H.browser('usr5.localhost').post('/api/auth/login', { email: 'compta@usr5.ma', password: 'Nouveau-Mdp-2026' })).status, 200);
  const page = await H.request('GET', '/reset', { host: 'usr5.localhost', raw: true });
  assert.equal(page.status, 200); assert.equal(page.headers['referrer-policy'], 'no-referrer');
});

test('utilisateurs : un nouveau lien annule le précédent', async () => {
  const { c, w, comptaU } = await wsWithTeam('usr6');
  const a = await c.post(`/api/platform/workspaces/${w.id}/users/${comptaU.id}/reset-link`, {});
  const b = await c.post(`/api/platform/workspaces/${w.id}/users/${comptaU.id}/reset-link`, {});
  assert.equal((await H.request('POST', '/api/password-reset/lookup', { host: 'usr6.localhost', body: { token: a.body.lien.split('#t=')[1] } })).status, 410);
  assert.equal((await H.request('POST', '/api/password-reset/lookup', { host: 'usr6.localhost', body: { token: b.body.lien.split('#t=')[1] } })).status, 200);
});

test('TZ-1 : échéance d’invitation identique sur la page d’invitation et dans la console', async () => {
  const c = await con();
  const w = await createWs(c, 'tzinv');
  const lookup = await H.request('POST', '/api/invitations/lookup', { host: 'tzinv.localhost', body: { token: w.invitation.lien.split('#t=')[1] } });
  const inv = (await c.get(`/api/platform/workspaces/${w.id}/users`)).body.invitations[0];
  const me = (await c.get('/api/platform/me')).body;
  const T = require('../src/time-format');
  assert.equal(lookup.body.workspace.fuseau, 'Africa/Casablanca');
  assert.equal(T.formatLocal(lookup.body.expiresAt, lookup.body.workspace.fuseau), T.formatLocal(inv.expires_at, me.fuseau));
  assert.match(T.formatLocal(inv.expires_at, me.fuseau), /\(UTC\+[01]\)$/);
  const invJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'invite.js'), 'utf8');
  assert.match(invJs, /DPTime\.formatLocal\(d\.expiresAt, w\.fuseau\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'console-users.js'), 'utf8'), /C\.fdt\(i\.expires_at\)/);
});
