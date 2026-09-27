'use strict';
/* INC 3A — Phase 2 : espaces de travail pilotés depuis la console (création, abonnement, limites, suspension,
 * export puis suppression douce, maintenance). La console ne voit jamais de données comptables. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_pws_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
const EXPORTS = path.join(os.tmpdir(), 'exports');
process.on('exit', () => {
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
  try { for (const f of fs.readdirSync(EXPORTS)) if (/^suppr-/.test(f)) fs.rmSync(path.join(EXPORTS, f)); } catch (_) {}
});
process.env.TRUST_PROXY = 'loopback';

const H = require('./helpers/http');
const { consoleSession } = require('./helpers/console');
const { db } = require('../src/db');
const lifecycle = require('../src/lifecycle');
const workspace = require('../src/workspace');
after(() => H.stop());

const PW = 'Secret-1234';
let C;
async function con() { if (!C) C = await consoleSession(); return C; }
async function createWs(slug, extra = {}) {
  const c = await con();
  const r = await c.post('/api/platform/workspaces', { slug, nom: 'Cabinet ' + slug, raisonLegale: slug.toUpperCase() + ' SARL', adresse: 'Casablanca',
    ice: '001234567000089', ifFiscal: '12345678', contactNom: 'Contact', contactEmail: `contact@${slug}.ma`, couleur: '#2F3E6B', plan: 'pro',
    adminEmail: `admin@${slug}.ma`, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
/** Accepte l'invitation du premier administrateur sur l'hôte de l'espace et renvoie un navigateur connecté. */
async function acceptAdmin(created) {
  const token = created.invitation.lien.split('#t=')[1];
  const host = new URL(created.invitation.lien).hostname;
  const b = H.browser(host);
  const r = await b.post('/api/invitations/accept', { token, nom: 'Première Admin', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return b;
}

test('espaces : création « Prime » depuis la console → lien d’invitation unique vers prime.localhost, puis connexion', async () => {
  const c = await con();
  const r = await createWs('prime', { abonnement: { date_debut: '2026-09-01', date_fin: '2027-08-31', montant: 12000, statut_paiement: 'paye' } });
  assert.match(r.invitation.lien, /^http:\/\/prime\.localhost(:\d+)?\/invite#t=[\w-]{40,}$/);
  assert.ok(r.invitation.expire);
  const inv = db.prepare('SELECT * FROM invitation WHERE email=?').get('admin@prime.ma');
  assert.equal(inv.role, 'admin');
  assert.ok(!JSON.stringify(inv).includes(r.invitation.lien.split('#t=')[1]), 'jeton stocké haché');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=?').get(r.id).n, 0, 'aucun mot de passe choisi par la plateforme');
  const b = await acceptAdmin(r);
  const me = await b.get('/api/me');
  assert.equal(me.status, 200); assert.equal(me.body.user.role, 'admin'); assert.equal(me.body.cabinet.slug, 'prime');
  const relog = await H.browser('prime.localhost').post('/api/auth/login', { email: 'admin@prime.ma', password: PW });
  assert.equal(relog.status, 200);
  // Lien à usage unique.
  const again = await H.browser('prime.localhost').post('/api/invitations/accept', { token: r.invitation.lien.split('#t=')[1], nom: 'X', password: PW });
  assert.equal(again.status, 410);
  // Journaux : plateforme + espace (attribué à l'équipe DelaiPay).
  const pa = (await c.get('/api/platform/audit?type=espace&cible=' + r.id)).body.rows;
  assert.ok(pa.some(x => x.action === 'espace_cree' && x.admin_email === c.email));
  const wa = await b.get('/api/audit');
  assert.ok(wa.body.some(x => x.action === 'create' && x.entite === 'espace_travail' && /Équipe DelaiPay/.test(x.user_nom || '')));
  const d = (await c.get('/api/platform/workspaces/' + r.id)).body;
  assert.equal(d.identite.ice, '001234567000089'); assert.equal(d.abonnement.statut_paiement, 'paye');
});

test('espaces : identifiant validé, unique, réservé refusé', async () => {
  const c = await con();
  for (const [slug, re] of [['admin', /réservé/], ['support', /réservé/], ['Pr ime', /2 à 40/], ['-x', /2 à 40/]]) {
    const r = await c.get('/api/platform/workspaces/check-slug?slug=' + encodeURIComponent(slug));
    assert.equal(r.body.ok, false, slug); assert.match(r.body.error, re, slug);
  }
  await createWs('unique1');
  assert.match((await c.get('/api/platform/workspaces/check-slug?slug=unique1')).body.error, /déjà utilisé/);
  const dup = await c.post('/api/platform/workspaces', { slug: 'unique1', nom: 'X', adminEmail: 'a@b.ma' });
  assert.equal(dup.status, 409);
  const bad = await c.post('/api/platform/workspaces', { slug: 'www', nom: 'X', adminEmail: 'a@b.ma' });
  assert.equal(bad.status, 400);
  const badIce = await c.post('/api/platform/workspaces', { slug: 'iceko', nom: 'X', adminEmail: 'a@b.ma', ice: '123' });
  assert.equal(badIce.status, 400); assert.match(badIce.body.error, /ICE/);
  assert.ok(!db.prepare(`SELECT 1 FROM cabinet WHERE slug='iceko'`).get(), 'rien créé');
});

test('espaces : création transactionnelle en mode invitation (échec → ni espace ni invitation)', () => {
  assert.throws(() => workspace.createWorkspace({ slug: 'txko', nom: 'Tx', admin: { email: 'a@txko.ma', invite: true }, onInsideTransaction: () => { throw new Error('panne'); } }), /panne/);
  assert.ok(!db.prepare(`SELECT 1 FROM cabinet WHERE slug='txko'`).get());
  assert.ok(!db.prepare(`SELECT 1 FROM invitation WHERE email='a@txko.ma'`).get());
});

test('espaces : la console ne renvoie que des métadonnées (aucun nom de client ni facture)', async () => {
  const c = await con();
  const r = await createWs('meta');
  const b = await acceptAdmin(r);
  assert.equal((await b.post('/api/clients', { raison_sociale: 'CLIENT CONFIDENTIEL SARL', ice: '009999999000001' })).status, 200);
  const list = await c.get('/api/platform/workspaces');
  const row = list.body.rows.find(x => x.slug === 'meta');
  assert.equal(row.clients, 1); assert.equal(row.utilisateurs, 1); assert.equal(row.factures, 0);
  assert.ok(row.sessionsActives >= 1); assert.ok(row.derniereActivite); assert.ok(row.empreinte.total > 0);
  for (const body of [list.body, (await c.get('/api/platform/workspaces/' + r.id)).body])
    assert.ok(!JSON.stringify(body).includes('CONFIDENTIEL') && !JSON.stringify(body).includes('009999999000001'), 'aucune donnée de client');
});

test('abonnement : échéance ≤ 30 j signalée ; échu → grâce (accès complet) puis lecture seule (jamais de suppression)', async () => {
  const c = await con();
  const r = await createWs('abo');
  const b = await acceptAdmin(r);
  const t = lifecycle.today();
  const put = body => c.put(`/api/platform/workspaces/${r.id}/subscription`, body);
  let s = await put({ plan: 'pro', date_debut: lifecycle.addDays(t, -300), date_fin: lifecycle.addDays(t, 20), montant: '1 200,50'.replace(' ', ''), statut_paiement: 'en_attente' });
  assert.equal(s.status, 200); assert.equal(s.body.abonnement.etat, 'bientot'); assert.equal(s.body.abonnement.montant, 1200.5);
  s = await put({ plan: 'pro', date_debut: lifecycle.addDays(t, -400), date_fin: lifecycle.addDays(t, -3), grace_jours: 10, statut_paiement: 'en_retard' });
  assert.equal(s.body.abonnement.etat, 'grace');
  assert.equal((await c.get('/api/platform/workspaces')).body.rows.find(x => x.slug === 'abo').statut, 'expire');
  assert.equal((await b.post('/api/clients', { raison_sociale: 'PENDANT GRACE' })).status, 200, 'grâce : écriture autorisée');
  assert.equal((await b.get('/api/me')).body.plateforme.abonnement.etat, 'grace');
  s = await put({ plan: 'pro', date_debut: lifecycle.addDays(t, -400), date_fin: lifecycle.addDays(t, -30), grace_jours: 10 });
  assert.equal(s.body.abonnement.etat, 'lecture_seule');
  const w = await b.post('/api/clients', { raison_sociale: 'APRES GRACE' });
  assert.equal(w.status, 403); assert.equal(w.body.code, 'abonnement_expire'); assert.match(w.body.error, /lecture seule/);
  assert.equal((await b.get('/api/clients')).status, 200, 'consultation toujours possible');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entreprise WHERE cabinet_id=?').get(r.id).n, 1, 'aucune donnée supprimée');
  const bad = await put({ date_debut: '2026-05-01', date_fin: '2026-04-01' });
  assert.equal(bad.status, 400);
  const pa = (await c.get('/api/platform/audit?type=espace&cible=' + r.id)).body.rows.filter(x => x.action === 'abonnement_modifie');
  assert.ok(pa.length >= 3 && pa[0].avant && pa[0].apres, 'avant → après');
});

test('limites : nombre d’utilisateurs et de clients contrôlé côté serveur (message en français)', async () => {
  const c = await con();
  const r = await createWs('lim', { maxUtilisateurs: 2, maxClients: 1 });
  const b = await acceptAdmin(r);
  assert.equal((await b.post('/api/invitations', { email: 'u1@lim.ma', role: 'lecture' })).status, 200);
  const inv2 = await b.post('/api/invitations', { email: 'u2@lim.ma', role: 'lecture' });
  assert.equal(inv2.status, 403); assert.match(inv2.body.error, /Limite de l’abonnement atteinte : 2 utilisateurs au maximum/);
  assert.equal((await b.post('/api/clients', { raison_sociale: 'UN' })).status, 200);
  const cl2 = await b.post('/api/clients', { raison_sociale: 'DEUX' });
  assert.equal(cl2.status, 403); assert.match(cl2.body.error, /1 dossier client au maximum/);
  assert.equal((await c.patch('/api/platform/workspaces/' + r.id, { maxClients: 5 })).status, 200);
  assert.equal((await b.post('/api/clients', { raison_sociale: 'DEUX' })).status, 200, 'limite relevée');
});

test('suspension : motif obligatoire, sessions fermées, message aux utilisateurs ; réactivation motivée', async () => {
  const c = await con();
  const r = await createWs('susp');
  const b = await acceptAdmin(r);
  assert.equal((await c.post(`/api/platform/workspaces/${r.id}/suspend`, {})).status, 400);
  const s = await c.post(`/api/platform/workspaces/${r.id}/suspend`, { motif: 'Impayé T3' });
  assert.equal(s.status, 200); assert.ok(s.body.sessionsFermees >= 1);
  const me = await b.get('/api/me');
  assert.equal(me.status, 401); assert.match(me.body.error, /suspendu/);
  const login = await H.browser('susp.localhost').post('/api/auth/login', { email: 'admin@susp.ma', password: PW });
  assert.equal(login.status, 403); assert.match(login.body.error, /suspendu/);
  assert.equal((await c.post(`/api/platform/workspaces/${r.id}/reactivate`, {})).status, 400);
  assert.equal((await c.post(`/api/platform/workspaces/${r.id}/reactivate`, { motif: 'Règlement reçu' })).status, 200);
  const b2 = H.browser('susp.localhost');
  assert.equal((await b2.post('/api/auth/login', { email: 'admin@susp.ma', password: PW })).status, 200);
  const wa = (await b2.get('/api/audit')).body.map(x => x.action);
  assert.ok(wa.includes('suspension_espace') && wa.includes('reactivation_espace'), 'visible au journal de l’espace');
});

test('suppression : export préalable (serveur, sans secrets), saisie de l’identifiant, suppression douce réversible', async () => {
  const c = await con();
  const r = await createWs('suppr');
  const b = await acceptAdmin(r);
  await b.post('/api/clients', { raison_sociale: 'A CONSERVER' });
  const noExport = await c.post(`/api/platform/workspaces/${r.id}/delete`, { motif: 'Fin de contrat', confirmation: 'suppr' });
  assert.equal(noExport.status, 409); assert.equal(noExport.body.code, 'export_requis');
  const ex = await c.post(`/api/platform/workspaces/${r.id}/export`, {});
  assert.equal(ex.status, 200);
  const file = path.join(path.dirname(process.env.DB_PATH), 'exports', ex.body.export.fichier);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(crypto.createHash('sha256').update(content).digest('hex'), ex.body.export.sha256);
  const json = JSON.parse(content);
  assert.equal(json.tables.entreprise.length, 1);
  assert.ok(!content.includes('password_hash') && !content.includes('token_hash'), 'aucun secret exporté');
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.ok(!('tables' in ex.body.export), 'le contenu n’est pas renvoyé à la console');
  const wrong = await c.post(`/api/platform/workspaces/${r.id}/delete`, { motif: 'Fin', confirmation: 'SUPPR', exportId: ex.body.export.id });
  assert.equal(wrong.status, 400);
  const del = await c.post(`/api/platform/workspaces/${r.id}/delete`, { motif: 'Fin de contrat', confirmation: 'suppr', exportId: ex.body.export.id });
  assert.equal(del.status, 200); assert.ok(del.body.purgeApres);
  assert.equal((await b.get('/api/me')).status, 401, 'sessions fermées');
  const t = await H.request('GET', '/api/tenant', { host: 'suppr.localhost' });
  assert.equal(t.body.deleted, true); assert.equal(t.body.known, false);
  const login = await H.browser('suppr.localhost').post('/api/auth/login', { email: 'admin@suppr.ma', password: PW });
  assert.equal(login.status, 403); assert.match(login.body.error, /n’est plus disponible/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entreprise WHERE cabinet_id=?').get(r.id).n, 1, 'données intactes (purge manuelle)');
  assert.equal((await c.get('/api/platform/workspaces')).body.rows.find(x => x.slug === 'suppr').statut, 'supprime');
  assert.equal((await c.post(`/api/platform/workspaces/${r.id}/restore`, { motif: 'Erreur' })).status, 200);
  assert.equal((await c.get('/api/platform/workspaces/' + r.id)).body.statut, 'suspendu', 'restauré suspendu');
});

test('maintenance : bandeau global et par espace (message, heure de fin) sur la connexion et dans l’application', async () => {
  const c = await con();
  const r = await createWs('maint');
  const b = await acceptAdmin(r);
  assert.equal((await c.put('/api/platform/maintenance', { message: 'Mise à jour ce soir 22 h – 23 h.', fin: new Date(Date.now() + 3600e3).toISOString() })).status, 200);
  assert.equal((await c.put(`/api/platform/workspaces/${r.id}/maintenance`, { message: 'Migration de vos données.' })).status, 200);
  let t = await H.request('GET', '/api/tenant', { host: 'maint.localhost' });
  assert.deepEqual(t.body.maintenance.map(m => m.portee), ['plateforme', 'espace']);
  const me = await b.get('/api/me');
  assert.equal(me.body.plateforme.maintenance.length, 2);
  const other = await H.request('GET', '/api/tenant', { host: 'prime.localhost' });
  assert.deepEqual(other.body.maintenance.map(m => m.portee), ['plateforme'], 'le bandeau d’espace ne concerne que son espace');
  assert.equal((await c.put('/api/platform/maintenance', { message: 'Passée', fin: new Date(Date.now() - 1000).toISOString() })).status, 200);
  t = await H.request('GET', '/api/tenant', { host: 'maint.localhost' });
  assert.deepEqual(t.body.maintenance.map(m => m.portee), ['espace'], 'bandeau échu : masqué');
  await c.del('/api/platform/maintenance'); await c.del(`/api/platform/workspaces/${r.id}/maintenance`);
  t = await H.request('GET', '/api/tenant', { host: 'maint.localhost' });
  assert.equal(t.body.maintenance.length, 0);
});

test('espaces : routes de la console inaccessibles sans session complète', async () => {
  const anon = H.browser('admin.localhost', { headers: { 'X-DP-Console': '1', 'X-Forwarded-For': '192.0.2.250' } });
  for (const [m, p] of [['GET', '/api/platform/workspaces'], ['POST', '/api/platform/workspaces'], ['POST', '/api/platform/workspaces/x/suspend']])
    assert.equal((await anon.req(m, p, m === 'GET' ? undefined : {})).status, 401, p);
});
