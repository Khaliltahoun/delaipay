'use strict';
/* npm run demo:reset — remise à blanc d'un espace de démonstration, avec tous ses garde-fous. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'delaipay_reset_'));
process.env.DB_PATH = path.join(DIR, 'demo.db');
process.env.NODE_ENV = 'test';
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {} });

const { DatabaseSync } = require('node:sqlite');
const { db } = require('../src/db');
const workspace = require('../src/workspace');
const importer = require('../src/importer');
const { uid } = require('../src/util');
const fx = require('../src/demo-fixture');
const { resetDemoWorkspace, DemoResetError } = require('../src/demo-reset');

const ENV = { DB_PATH: process.env.DB_PATH, NODE_ENV: 'test' };
const BUSINESS = ['entreprise', 'fournisseur', 'facture', 'convention', 'document', 'declaration', 'anomalie', 'import_lot', 'invitation'];
const count = (t, cab) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE cabinet_id=?`).get(cab).n;

function demoWorkspace(slug, email) {
  const w = workspace.createWorkspace({ slug, nom: 'Démo ' + slug, raisonLegale: 'Démo SARL', contactEmail: 'contact@' + slug + '.demo',
    admin: { email: email || `admin@${slug}.demo`, nom: 'Admin', password: 'DemoSaaS-2026' } });
  const ent = uid('ent');
  db.prepare('INSERT INTO entreprise (id,cabinet_id,raison_sociale) VALUES (?,?,?)').run(ent, w.cabinetId, 'STE ESSAI SARL');
  importer.importWorkbook(fx.demoWorkbookBuffer(), { cabinetId: w.cabinetId, entrepriseId: ent, sourceName: 'x.xlsx', periode: { annee: 2026, trimestre: 1 } });
  const four = db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? LIMIT 1').get(ent).id;
  db.prepare('INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut) VALUES (?,?,?,?,?,?)').run(uid('conv'), w.cabinetId, ent, four, 120, 'valide');
  workspace.createInvitation(w.cabinetId, w.userId, { email: 'invite@' + slug + '.demo', role: 'lecture' });
  workspace.updateOnboarding(w.cabinetId, w.userId, { current: 'factures', periode: { annee: 2026, trimestre: 1 } });
  return w;
}

test('demo:reset — garde-fous : production, base implicite ou par défaut, confirmation, espace canonique', () => {
  demoWorkspace('reset-a');
  const refuse = (opts, re) => assert.throws(() => resetDemoWorkspace(opts), e => e instanceof DemoResetError && re.test(e.message));
  refuse({ slug: 'reset-a', confirm: 'reset-a', env: { ...ENV, NODE_ENV: 'production' } }, /réservée aux bases de démonstration/);
  refuse({ slug: 'reset-a', confirm: 'reset-a', env: { NODE_ENV: 'test' } }, /DB_PATH/);
  refuse({ slug: 'reset-a', confirm: 'reset-a', env: { DB_PATH: path.join(__dirname, '..', 'data', 'delaipay.db') } }, /base par défaut/);
  refuse({ slug: 'reset-a', env: ENV }, /--confirm reset-a/);
  refuse({ slug: 'reset-a', confirm: 'reset-b', env: ENV }, /--confirm reset-a/);
  refuse({ slug: 'hlz', confirm: 'hlz', env: ENV }, /données de référence/);
  refuse({ slug: 'inconnu', confirm: 'inconnu', env: ENV }, /Aucun espace/);
});

test('demo:reset — refuse un espace aux comptes réels ou contenant le client de référence', () => {
  demoWorkspace('reset-reel', 'expert@cabinet-reel.ma');
  assert.throws(() => resetDemoWorkspace({ slug: 'reset-reel', confirm: 'reset-reel', env: ENV }), /comptes non fictifs/);
  const w = demoWorkspace('reset-ref');
  db.prepare('INSERT INTO entreprise (id,cabinet_id,raison_sociale) VALUES (?,?,?)').run(uid('ent'), w.cabinetId, fx.DEMO_CLIENT.raison_sociale);
  assert.throws(() => resetDemoWorkspace({ slug: 'reset-ref', confirm: 'reset-ref', env: ENV }), /client de référence/);
  assert.ok(count('facture', w.cabinetId) > 0, 'rien supprimé après un refus');
});

test('demo:reset — espace remis à blanc, sauvegarde préalable, comptes conservés, autres espaces intacts', () => {
  const A = demoWorkspace('reset-ok'), B = demoWorkspace('reset-voisin');
  const beforeB = Object.fromEntries(BUSINESS.map(t => [t, count(t, B.cabinetId)]));
  const facturesA = count('facture', A.cabinetId);
  assert.equal(facturesA, 36);
  const r = resetDemoWorkspace({ slug: 'reset-ok', confirm: 'reset-ok', env: ENV });
  for (const t of BUSINESS) assert.equal(count(t, A.cabinetId), 0, `${t} vidée`);
  assert.deepEqual(Object.fromEntries(BUSINESS.map(t => [t, count(t, B.cabinetId)])), beforeB, 'espace voisin intact');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=?').get(A.cabinetId).n, 1, 'comptes conservés');
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(A.cabinetId);
  assert.equal(cab.slug, 'reset-ok'); assert.equal(cab.raison_legale, null); assert.equal(cab.onboarding_json, null);
  const ob = workspace.onboardingState(A.cabinetId);
  assert.equal(ob.started, false); assert.equal(ob.facts.clients, 0); assert.equal(ob.facts.cabinetConfigure, false);
  assert.ok(ob.steps.filter(s => s.key !== 'pret').every(s => s.status === 'todo'), 'onboarding repart de zéro');
  // La sauvegarde contient l'état d'avant.
  assert.ok(fs.existsSync(r.backup) && r.backup.startsWith(path.join(DIR, 'backups')));
  const bk = new DatabaseSync(r.backup, { readOnly: true });
  assert.equal(bk.prepare('SELECT COUNT(*) n FROM facture WHERE cabinet_id=?').get(A.cabinetId).n, facturesA);
  bk.close();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE cabinet_id=? AND action='reinitialisation_demo'").get(A.cabinetId).n, 1, 'remise à blanc tracée');
  assert.ok(Object.values(r.counts).reduce((a, b) => a + b, 0) >= 36);
});
