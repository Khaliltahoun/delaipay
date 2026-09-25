'use strict';
/* Seed de démonstration : données FICTIVES, référence T1 2026 inchangée, mot de passe jamais codé en dur,
 * et aucun espace nouvellement créé ne reçoit le client de démonstration ni aucune donnée métier du seed. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_seed_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN_EMAIL;
process.env.NODE_ENV = 'test';

const express = require('express');
const cookieParser = require('cookie-parser');
const { db } = require('../src/db');
const auth = require('../src/auth');
const { ensureSeed } = require('../src/seed');
const workspace = require('../src/workspace');
const { DEMO_CLIENT, DEMO_PERSONA } = require('../src/demo-fixture');

// Nouvelle référence du fichier de déclaration T1 2026 (noms et IF fictifs) — voir collaboration/DECISIONS.md.
const DECLARATION_CSV_MD5 = 'a7d1acaac0688170ef95fce6b7bb2082';
const BUSINESS_TABLES = ['entreprise', 'fournisseur', 'facture', 'convention', 'document', 'declaration', 'anomalie', 'import_lot'];

let seeded, srv;
const createdUploads = [];
after(() => {
  try { srv && srv.close(); } catch (_) {}
  for (const f of createdUploads) { try { fs.rmSync(path.join(__dirname, '..', 'uploads', f)); } catch (_) {} }
  for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
});

test('seed : refuse de démarrer en production sans ADMIN_PASSWORD (aucun mot de passe par défaut)', async () => {
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(ensureSeed(), /ADMIN_PASSWORD requis/); }
  finally { process.env.NODE_ENV = 'test'; }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cabinet').get().n, 0, 'rien créé');
});

test('seed : mot de passe aléatoire généré (hors production), jamais une valeur fixe', async () => {
  seeded = await ensureSeed();
  assert.equal(seeded.seeded, true);
  assert.equal(seeded.email, DEMO_PERSONA.email);
  assert.match(seeded.password, /^Demo-[A-Za-z0-9_-]{12}$/, 'mot de passe généré, affiché une seule fois');
  const u = db.prepare('SELECT * FROM utilisateur WHERE email=?').get(seeded.email);
  assert.ok(auth.verifyPassword(seeded.password, u.password_hash), 'le mot de passe généré ouvre le compte');
  assert.ok(!u.password_hash.includes(seeded.password), 'stocké haché');
  for (const c of db.prepare('SELECT fichier FROM convention WHERE fichier IS NOT NULL').all()) createdUploads.push(c.fichier);
  assert.equal((await ensureSeed()).seeded, false, 'idempotent : un second démarrage ne recrée rien');
});

test('seed : client de démonstration fictif et référence T1 2026 inchangée (36 · 16 · 350 964,42 · 7 025,33)', async () => {
  const e = db.prepare('SELECT * FROM entreprise').get();
  assert.equal(e.raison_sociale, DEMO_CLIENT.raison_sociale);
  const f = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN retard_jours>0 THEN 1 ELSE 0 END) late, ROUND(SUM(montant_amende),2) amende
                        FROM facture WHERE entreprise_id=?`).get(e.id);
  assert.equal(f.n, 36); assert.equal(f.late, 16); assert.equal(f.amende, 7025.33);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE entreprise_id=?').get(e.id).n, 4, '4 conventions de démonstration');

  const app = express(); app.use(cookieParser()); app.use(express.json()); app.use('/api', require('../src/api'));
  srv = app.listen(0); srv.unref();
  const u = db.prepare('SELECT * FROM utilisateur').get();
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/clients/${e.id}/declaration/export.csv?annee=2026&trimestre=1`,
    { headers: { Cookie: auth.COOKIE + '=' + auth.signToken(u) } });
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  assert.match(text, /\nTOTAL;16 ligne\(s\);350964\.42;0\.00;350964\.42;;7025\.33;2026;1\n/, 'total déclaré inchangé');
  assert.equal(crypto.createHash('md5').update(bytes).digest('hex'), DECLARATION_CSV_MD5, 'fichier de déclaration = nouvelle référence');
});

test('seed : un NOUVEL espace ne reçoit jamais le client de démonstration ni aucune donnée métier', () => {
  const before = Object.fromEntries(BUSINESS_TABLES.map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  const w = workspace.createWorkspace({ slug: 'neuf-isole', nom: 'Cabinet Neuf', admin: { email: 'admin@neuf.demo', nom: 'Admin Neuf', password: 'Neuf-Espace-2026' } });
  for (const t of BUSINESS_TABLES)
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE cabinet_id=?`).get(w.cabinetId).n, 0, `${t} vide pour le nouvel espace`);
  const after_ = Object.fromEntries(BUSINESS_TABLES.map(t => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  assert.deepEqual(after_, before, 'la création d’espace n’écrit aucune donnée métier');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=?').get(w.cabinetId).n, 1, 'seul le premier administrateur');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entreprise WHERE raison_sociale=?').get(DEMO_CLIENT.raison_sociale).n, 1, 'le client de démonstration n’existe que dans l’espace seedé');
});
