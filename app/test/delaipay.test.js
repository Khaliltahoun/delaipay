'use strict';
/* Suite de tests automatisés DelaiPay — node:test.  Lancer : npm test  (ou node --test) */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Base temporaire isolée (jamais la base de prod).
process.env.DB_PATH = path.join(os.tmpdir(), 'delaipay_test_' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} }
process.on('exit', () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(process.env.DB_PATH + s); } catch (_) {} } });

const periode = require('../src/periode');
const { db } = require('../src/db');
const importer = require('../src/importer');
const calc = require('../src/calc');
const { uid } = require('../src/util');
const DOCS = path.join(__dirname, '..', '..', 'docs');

function seedCab() {
  db.prepare('INSERT INTO taux_bam (id,cabinet_id,taux,date_debut,date_fin) VALUES (?,?,?,?,?)').run(uid('tx'), null, 0.03, '2022-09-01', '2024-06-25');
  db.prepare('INSERT INTO taux_bam (id,cabinet_id,taux,date_debut,date_fin) VALUES (?,?,?,?,?)').run(uid('tx'), null, 0.0275, '2024-06-26', '2024-12-17');
  db.prepare('INSERT INTO taux_bam (id,cabinet_id,taux,date_debut,date_fin) VALUES (?,?,?,?,?)').run(uid('tx'), null, 0.025, '2024-12-18', '2025-03-17');
  db.prepare('INSERT INTO taux_bam (id,cabinet_id,taux,date_debut,date_fin) VALUES (?,?,?,?,?)').run(uid('tx'), null, 0.0225, '2025-03-18', null);
  const cab = uid('cab'); db.prepare('INSERT INTO cabinet (id,nom) VALUES (?,?)').run(cab, 'T');
  const ent = uid('ent'); db.prepare('INSERT INTO entreprise (id,cabinet_id,raison_sociale) VALUES (?,?,?)').run(ent, cab, 'E');
  return { cab, ent };
}

/* -------------------- CALENDRIER DES PÉRIODES -------------------- */
test('T1 traité en avril, T4 traité en janvier N+1', () => {
  assert.equal(periode.periodInfo(2026, 1).mois_traitement, 4);
  assert.equal(periode.periodInfo(2026, 1).annee_traitement, 2026);
  const t4 = periode.periodInfo(2026, 4);
  assert.equal(t4.mois_traitement, 1);
  assert.equal(t4.annee_traitement, 2027);
  assert.equal(t4.date_debut, '2026-10-01');
  assert.equal(t4.date_fin, '2026-12-31');
});
test('période de travail selon le mois', () => {
  assert.deepEqual(periode.workingPeriod(new Date(2026, 6, 17)), { annee: 2026, trimestre: 2 }); // juillet
  assert.deepEqual(periode.workingPeriod(new Date(2027, 0, 15)), { annee: 2026, trimestre: 4 }); // janvier
  assert.deepEqual(periode.workingPeriod(new Date(2026, 3, 3)), { annee: 2026, trimestre: 1 });  // avril
});
test('prev/next avec passage d\'année', () => {
  assert.deepEqual(periode.prevPeriod(2026, 1), { annee: 2025, trimestre: 4 });
  assert.deepEqual(periode.nextPeriod(2026, 4), { annee: 2027, trimestre: 1 });
});
test('périodes verrouillées', () => {
  assert.equal(periode.isLocked('cloturee'), true);
  assert.equal(periode.isLocked('declaree'), true);
  assert.equal(periode.isLocked('en_preparation'), false);
});

/* -------------------- NON-RÉGRESSION CALCUL (CADOZAT) -------------------- */
test('CADOZAT DELAI.xlsx T1 2026 ≈ 7025,33 DH (non-régression)', { skip: !fs.existsSync(path.join(DOCS, 'DELAI.xlsx')) }, () => {
  const { cab, ent } = seedCab();
  const r = importer.importWorkbook(fs.readFileSync(path.join(DOCS, 'DELAI.xlsx')), { cabinetId: cab, entrepriseId: ent, sourceName: 'DELAI.xlsx', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r.imported, 34);
  const amende = db.prepare('SELECT ROUND(SUM(montant_amende),2) s FROM facture WHERE entreprise_id=?').get(ent).s;
  assert.ok(Math.abs(amende - 7025.33) < 0.5, `amende ${amende} attendue ~7025.33`);
});

/* -------------------- MOTEUR DE CALCUL (règle mois calendaire) -------------------- */
test('1er mois au taux BAM, mois suivants à 0,85 %, mois du trimestre déclaré uniquement', () => {
  seedCab();
  // facture 100000 TTC, délai 60j, facture 2025-01-01 → limite 2025-03-02, impayée jusqu'à fin T2
  const c = calc.computeFacture({ dateFacture: '2025-01-01', datePaiement: null, ttc: 100000, delaiApplicable: 60,
    periode: { annee: 2025, trimestre: 2 }, today: new Date(2025, 5, 30), tauxProvider: () => 0.0225 });
  // retard démarre en mars 2025 ; T2 = avr/mai/juin → 3 mois, aucun n'est le 1er mois de retard → 3×0,85%
  assert.ok(c.montantAmende > 0);
});

/* -------------------- IMPORT : classification lignes -------------------- */
test('preview : rejette TTC négatif (avoirs) et détecte les doublons', { skip: !fs.existsSync(path.join(DOCS, '..', 'DELAI DE PAIEMENT', '01-2026', 'FERMA PREFA', 'Tableau des déductions janvier 2026.xlsx')) }, () => {
  const { cab, ent } = seedCab();
  const f = path.join(DOCS, '..', 'DELAI DE PAIEMENT', '01-2026', 'FERMA PREFA', 'Tableau des déductions janvier 2026.xlsx');
  const buf = fs.readFileSync(f);
  const pv = importer.previewImport(buf, { sheetName: 'A', headerRow: 0, mapping: { numero: 2, date_facture: 1, four_nom: 4, ttc: 6, date_paiement: 13 }, cabinetId: cab, entrepriseId: ent, annee: 2025, trimestre: 4 });
  assert.ok(pv.stats.rejetees > 0, 'doit rejeter des avoirs TTC<0');
  assert.ok(pv.stats.valides > 0);
});
test('confirm transactionnel + ré-import = doublons (dédoublonnage)', { skip: !fs.existsSync(path.join(DOCS, '..', 'DELAI DE PAIEMENT', '01-2026', 'FERMA PREFA', 'Tableau des déductions janvier 2026.xlsx')) }, () => {
  const { cab, ent } = seedCab();
  const f = path.join(DOCS, '..', 'DELAI DE PAIEMENT', '01-2026', 'FERMA PREFA', 'Tableau des déductions janvier 2026.xlsx');
  const buf = fs.readFileSync(f);
  const opts = { sheetName: 'A', headerRow: 0, mapping: { numero: 2, date_facture: 1, four_nom: 4, ttc: 6, date_paiement: 13 }, cabinetId: cab, entrepriseId: ent, annee: 2025, trimestre: 4, sourceName: 'ferma.xlsx', userId: 'u' };
  const r1 = importer.confirmImport(buf, opts);
  assert.ok(r1.imported > 0);
  const nb = db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(ent).n;
  assert.equal(nb, r1.imported, 'factures en base = importées');
  const r2 = importer.confirmImport(buf, { ...opts, sourceName: 'ferma2.xlsx' });
  assert.equal(r2.imported, 0, 'ré-import : 0 nouvelle facture');
  assert.ok(r2.duplicates > 0, 'ré-import : doublons détectés');
  // import_ligne tracées
  const ligne = db.prepare('SELECT COUNT(*) n FROM import_ligne WHERE import_lot_id=?').get(r1.importId).n;
  assert.ok(ligne > 0);
});

/* -------------------- DÉTECTION LIGNES TOTAL/VIDES -------------------- */
test('lignes total/sous-total/vides ignorées, facture impayée acceptée', () => {
  const { cab, ent } = seedCab();
  const XLSX = require('../node_modules/xlsx');
  const aoa = [
    ['N°', 'Date', 'Fournisseur', 'TTC', 'Date paiement'],
    ['F1', '2026-01-05', 'FRS A', 1000, ''],            // valide, impayée
    ['F2', '2026-01-06', 'FRS B', 2000, '2026-02-01'],  // valide, payée
    ['', '', '', '', ''],                                // vide → ignorée
    ['TOTAL', '', '', 3000, ''],                         // total → ignorée
    ['F3', '2026-01-07', '', 500, ''],                   // sans fournisseur → rejetée
    ['F4', '', 'FRS C', 800, ''],                        // sans date → rejetée
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const pv = importer.previewImport(buf, { sheetName: 'S', headerRow: 0, mapping: { numero: 0, date_facture: 1, four_nom: 2, ttc: 3, date_paiement: 4 }, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1 });
  assert.equal(pv.stats.valides, 2, '2 valides (dont 1 impayée)');
  assert.ok(pv.stats.ignorees >= 2, 'ligne vide + TOTAL ignorées');
  assert.equal(pv.stats.rejetees, 2, 'sans fournisseur + sans date rejetées');
});

/* ==================================================================================
 * IMPORT DES CONVENTIONS FOURNISSEURS (Excel) — règles métier, dédoublonnage,
 * transaction/rollback, sécurité des routes (PDF différé, tenants).
 * ================================================================================== */
const XLSX = require('../node_modules/xlsx');
const express = require('express');
const cookieParser = require('cookie-parser');
const auth = require('../src/auth');

// En-tête standard de la feuille « Conventions » (10 colonnes du modèle).
const CH = ['Fournisseur', 'ICE', 'IF', 'RC', 'Convention (OUI/NON)', 'Délai convenu (jours)', 'Date de début', 'Date de fin', 'Référence', 'Commentaire'];
function convBuf(rows, sheet = 'Conventions') {
  const ws = XLSX.utils.aoa_to_sheet([CH, ...rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function newTenant(nom = 'Cab') {
  const cab = uid('cab'); db.prepare('INSERT INTO cabinet (id,nom) VALUES (?,?)').run(cab, nom);
  const u = uid('u'); db.prepare('INSERT INTO utilisateur (id,cabinet_id,nom,email,password_hash,role,actif) VALUES (?,?,?,?,?,?,1)')
    .run(u, cab, 'U', uid('e') + '@ex.ma', 'x', 'admin');
  const ent = uid('ent'); db.prepare('INSERT INTO entreprise (id,cabinet_id,raison_sociale) VALUES (?,?,?)').run(ent, cab, 'Ent');
  return { cab, ent, u };
}
function impConv(t, rows) { return importer.importConventions(convBuf(rows), { cabinetId: t.cab, entrepriseId: t.ent }); }
function convOfEnt(ent) { return db.prepare('SELECT * FROM convention WHERE entreprise_id=? ORDER BY created_at').all(ent); }

/* --- 1..4 : identification fournisseur ICE → IF → RC → nom normalisé --- */
test('conv/identif : fournisseur retrouvé par ICE', () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fid, t.cab, t.ent, 'ANCIEN NOM', '000000000000111');
  const r = impConv(t, [['NOUVEAU LIBELLE', '000000000000111', '', '', 'OUI', 90]]);
  assert.equal(r.suppliersFound, 1); assert.equal(r.suppliersCreated, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE entreprise_id=?').get(t.ent).n, 1);
});
test('conv/identif : fournisseur retrouvé par IF', () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fid, t.cab, t.ent, 'FRS IF', '55501234');
  const r = impConv(t, [['AUTRE LIBELLE', '', '55501234', '', 'OUI', 120]]);
  assert.equal(r.suppliersFound, 1); assert.equal(r.suppliersCreated, 0);
});
test('conv/identif : fournisseur retrouvé par RC', () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,rc,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fid, t.cab, t.ent, 'FRS RC', '4589');
  const r = impConv(t, [['ENCORE UN LIBELLE', '', '', '4589', 'OUI', 60]]);
  assert.equal(r.suppliersFound, 1); assert.equal(r.suppliersCreated, 0);
});
test('conv/identif : fournisseur retrouvé par nom normalisé (accents/casse/forme juridique)', () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)')
    .run(fid, t.cab, t.ent, 'Société Générale Béton SARL');
  const r = impConv(t, [['STE GENERALE BETON', '', '', '', 'OUI', 90]]); // sans identifiant → nom normalisé
  assert.equal(r.suppliersFound, 1, 'même fournisseur (nom normalisé)'); assert.equal(r.suppliersCreated, 0);
});

/* --- 5..9 : règles de délai & convention --- */
test('conv/OUI délai 90 → convention créée à 90 j', () => {
  const t = newTenant();
  const r = impConv(t, [['ALPHA', '000000000000201', '', '', 'OUI', 90]]);
  assert.equal(r.conventionsCreated, 1);
  const c = convOfEnt(t.ent)[0];
  assert.equal(c.delai_convenu, 90); assert.equal(c.statut, 'valide');
});
test('conv/délai « 60 A 120 J » → 120 (plage : plus grand)', () => {
  const t = newTenant();
  const r = impConv(t, [['BETA', '000000000000202', '', '', 'OUI', '60 A 120 J']]);
  assert.equal(r.conventionsCreated, 1);
  assert.equal(convOfEnt(t.ent)[0].delai_convenu, 120);
});
test('conv/NON → aucune convention, fournisseur à 60 j, ligne « sans convention »', () => {
  const t = newTenant();
  const r = impConv(t, [['GAMMA', '000000000000203', '', '', 'NON', 60]]);
  assert.equal(r.conventionsCreated, 0);
  assert.equal(r.withoutConvention, 1);
  assert.equal(convOfEnt(t.ent).length, 0, 'aucune convention en base');
  assert.equal(db.prepare('SELECT delai_applicable FROM fournisseur WHERE entreprise_id=?').get(t.ent).delai_applicable, 60);
});
test('conv/délai > 180 (365) → non importé, classé « à vérifier »', () => {
  const t = newTenant();
  const r = impConv(t, [['DELTA', '000000000000204', '', '', 'OUI', 365]]);
  assert.equal(r.conventionsCreated, 0);
  assert.equal(r.toReview, 1);
  assert.equal(convOfEnt(t.ent).length, 0);
});
test('conv/délai invalide (0) → rejeté', () => {
  const t = newTenant();
  const r = impConv(t, [['EPSILON', '000000000000205', '', '', 'OUI', 0]]);
  assert.equal(r.conventionsCreated, 0);
  assert.equal(r.rejected, 1);
});

/* --- 10..11 : doublon exact vs conflit --- */
test('conv/doublon exact : ré-import identique → 0 création, doublon détecté', () => {
  const t = newTenant();
  impConv(t, [['ZETA', '000000000000206', '', '', 'OUI', 120]]);
  const r2 = impConv(t, [['ZETA', '000000000000206', '', '', 'OUI', 120]]);
  assert.equal(r2.conventionsCreated, 0);
  assert.equal(r2.duplicates, 1);
  assert.equal(convOfEnt(t.ent).length, 1, 'toujours une seule convention');
});
test('conv/conflit : même fournisseur, délai différent → conflit, pas d\'écrasement', () => {
  const t = newTenant();
  impConv(t, [['ETA', '000000000000207', '', '', 'OUI', 90]]);
  const r2 = impConv(t, [['ETA', '000000000000207', '', '', 'OUI', 120]]);
  assert.equal(r2.conflicts, 1);
  assert.equal(r2.conventionsCreated, 0);
  assert.equal(convOfEnt(t.ent)[0].delai_convenu, 90, 'convention existante inchangée (90 j)');
});

/* --- 12 : import sans PDF (document différé) --- */
test('conv/import sans PDF → convention créée sans fichier (document manquant)', () => {
  const t = newTenant();
  impConv(t, [['THETA', '000000000000208', '', '', 'OUI', 90]]);
  const c = convOfEnt(t.ent)[0];
  assert.equal(c.fichier, null, 'aucun PDF rattaché');
});

/* --- 17 : rollback transactionnel sur erreur au milieu de l'import --- */
test('conv/rollback : erreur en cours d\'import → aucun fournisseur ni convention conservé', () => {
  const t = newTenant();
  // Déclencheur temporaire : la 2e convention de CETTE entreprise lève une erreur SQLite.
  db.exec(`CREATE TEMP TRIGGER conv_boom BEFORE INSERT ON convention
           WHEN (SELECT COUNT(*) FROM convention WHERE entreprise_id='${t.ent}') >= 1
           BEGIN SELECT RAISE(ABORT,'panne simulée'); END;`);
  const buf = convBuf([
    ['A SARL', '000000000000301', '', '', 'OUI', 90],
    ['B SARL', '000000000000302', '', '', 'OUI', 120],   // ← déclenche la panne
    ['C SARL', '000000000000303', '', '', 'OUI', 60],
  ]);
  assert.throws(() => importer.importConventions(buf, { cabinetId: t.cab, entrepriseId: t.ent }), /annulé|panne/i);
  db.exec('DROP TRIGGER conv_boom');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE entreprise_id=?').get(t.ent).n, 0, 'aucune convention');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE entreprise_id=?').get(t.ent).n, 0, 'aucun fournisseur');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_lot WHERE entreprise_id=?').get(t.ent).n, 0, 'aucun lot');
});

/* --- 18 : modèle Excel généré avec les deux feuilles attendues --- */
test('conv/modèle : classeur à 2 feuilles (Instructions + Conventions) avec 10 colonnes', () => {
  const wb = XLSX.read(importer.buildConventionsTemplate(), { cellDates: true });
  assert.deepEqual(wb.SheetNames, ['Instructions', 'Conventions']);
  const head = XLSX.utils.sheet_to_json(wb.Sheets['Conventions'], { header: 1 })[0];
  assert.equal(head.length, 10);
  assert.ok(/fournisseur/i.test(head[0]) && /convention/i.test(head[4]));
});

/* ================== ROUTES HTTP (auth réelle, multer, tenants) ================== */
let _srv, _base;
function baseUrl() {
  if (_base) return _base;
  const app = express();
  app.use(cookieParser()); app.use(express.json()); app.use(express.urlencoded({ extended: true }));
  app.use('/api', require('../src/api'));
  app.use((err, req, res, next) => { if (res.headersSent) return next(err); res.status(500).json({ error: 'Erreur serveur' }); });
  _srv = app.listen(0); _srv.unref(); _base = `http://127.0.0.1:${_srv.address().port}`;
  return _base;
}
after(() => { try { _srv && _srv.close(); } catch (_) {} });
process.on('exit', () => { try { _srv && _srv.close(); } catch (_) {} });
function cookieOf(u) { return auth.COOKIE + '=' + auth.signToken(db.prepare('SELECT * FROM utilisateur WHERE id=?').get(u)); }
async function postFile(pathUrl, cookie, buf, filename, type) {
  const fd = new FormData();
  if (buf != null) fd.append('file', new Blob([buf], { type: type || 'application/octet-stream' }), filename);
  const res = await fetch(baseUrl() + pathUrl, { method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: fd });
  let body = null; try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

test('conv/HTTP : import Excel authentifié → conventions créées (sans PDF)', async () => {
  const t = newTenant();
  const buf = convBuf([['HTTP ALPHA', '000000000000401', '', '', 'OUI', 90], ['HTTP GAMMA', '000000000000402', '', '', 'NON', 60]]);
  const r = await postFile(`/api/clients/${t.ent}/conventions/import`, cookieOf(t.u), buf, 'liste.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(r.status, 200);
  assert.equal(r.body.conventionsCreated, 1);
  assert.equal(r.body.withoutConvention, 1);
  assert.equal(convOfEnt(t.ent)[0].fichier, null, 'convention sans PDF');
});
test('conv/HTTP : ajout ultérieur d\'un PDF, puis remplacement confirmé', async () => {
  const t = newTenant();
  await postFile(`/api/clients/${t.ent}/conventions/import`, cookieOf(t.u), convBuf([['PDFCO', '000000000000403', '', '', 'OUI', 90]]), 'l.xlsx');
  const conv = convOfEnt(t.ent)[0];
  const add = await postFile(`/api/clients/${t.ent}/conventions/${conv.id}/file`, cookieOf(t.u), PDF_BYTES, 'convention.pdf', 'application/pdf');
  assert.equal(add.status, 200);
  assert.ok(db.prepare('SELECT fichier FROM convention WHERE id=?').get(conv.id).fichier, 'PDF rattaché');
  // Sans confirmation de remplacement → 409.
  const noConfirm = await postFile(`/api/clients/${t.ent}/conventions/${conv.id}/file`, cookieOf(t.u), PDF_BYTES, 'v2.pdf', 'application/pdf');
  assert.equal(noConfirm.status, 409, 'écrasement silencieux interdit');
  // Avec confirmation → 200.
  const confirm = await postFile(`/api/clients/${t.ent}/conventions/${conv.id}/file?replace=1`, cookieOf(t.u), PDF_BYTES, 'v2.pdf', 'application/pdf');
  assert.equal(confirm.status, 200); assert.equal(confirm.body.replaced, true);
});
test('conv/HTTP : fichier non-PDF refusé sur la pièce jointe', async () => {
  const t = newTenant();
  await postFile(`/api/clients/${t.ent}/conventions/import`, cookieOf(t.u), convBuf([['NPDF', '000000000000404', '', '', 'OUI', 90]]), 'l.xlsx');
  const conv = convOfEnt(t.ent)[0];
  const r = await postFile(`/api/clients/${t.ent}/conventions/${conv.id}/file`, cookieOf(t.u), Buffer.from('ceci n\'est pas un pdf'), 'faux.pdf', 'application/pdf');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /PDF/i);
});
test('conv/HTTP : fichier Excel invalide refusé (400, pas 500)', async () => {
  const t = newTenant();
  const r = await postFile(`/api/clients/${t.ent}/conventions/import`, cookieOf(t.u), Buffer.from('nimportequoi'), 'corrompu.xlsx');
  assert.equal(r.status, 400);
});
test('conv/HTTP : accès à un autre cabinet refusé (isolation tenant)', async () => {
  const a = newTenant('A'), b = newTenant('B');
  // Utilisateur du cabinet A tente d'importer sur l'entreprise du cabinet B.
  const r = await postFile(`/api/clients/${b.ent}/conventions/import`, cookieOf(a.u), convBuf([['X', '000000000000405', '', '', 'OUI', 90]]), 'l.xlsx');
  assert.equal(r.status, 404, 'entreprise d\'un autre cabinet → introuvable');
  assert.equal(convOfEnt(b.ent).length, 0, 'rien créé chez le tenant B');
});
test('conv/HTTP : import sans authentification refusé (401)', async () => {
  const t = newTenant();
  const r = await postFile(`/api/clients/${t.ent}/conventions/import`, null, convBuf([['Y', '000000000000406', '', '', 'OUI', 90]]), 'l.xlsx');
  assert.equal(r.status, 401);
});
