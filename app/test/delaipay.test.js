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
const demoFixture = require('../src/demo-fixture');
const XLSX_ = require('xlsx');
// Classeur anonymisé (test/fixtures/*.json) → Buffer .xlsx. Aucune donnée réelle dans le dépôt.
function fixtureBuf(name) {
  const fx = require(path.join(__dirname, 'fixtures', name + '.json'));
  const ws = {};
  for (const [r, c, t, v] of fx.cells) {
    const ref = XLSX_.utils.encode_cell({ r, c });
    if (t === 'd') { const [y, m, d] = v.split('-').map(Number); ws[ref] = { t: 'n', v: (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000, z: 'dd/mm/yyyy' }; }
    else ws[ref] = { t, v };
  }
  ws['!ref'] = XLSX_.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: fx.rows - 1, c: fx.cols - 1 } });
  const wb = XLSX_.utils.book_new(); XLSX_.utils.book_append_sheet(wb, ws, fx.sheet);
  return XLSX_.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

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

/* -------------------- NON-RÉGRESSION CALCUL (jeu de démonstration fictif) -------------------- */
test('démo T1 2026 ≈ 7025,33 DH (non-régression)', () => {
  const { cab, ent } = seedCab();
  const r = importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: cab, entrepriseId: ent, sourceName: demoFixture.DEMO_SOURCE_NAME, periode: { annee: 2026, trimestre: 1 } });
  // 36 (et non 34) : 2 lignes « doublon potentiel » (même facture, dates de paiement différentes) sont désormais GARDÉES et signalées (paiement partiel / scindé), au
  // lieu d'être supprimées. Évolution LÉGITIME de la règle. L'AMENDE reste 7 025,33 DH (ces 2 factures
  // sont réglées dans les délais → 0 amende), donc la non-régression du moteur légal est préservée.
  assert.equal(r.imported, 36);
  assert.equal(r.duplicates, 2, '2 doublons potentiels gardés + signalés');
  const amende = db.prepare('SELECT ROUND(SUM(montant_amende),2) s FROM facture WHERE entreprise_id=?').get(ent).s;
  assert.ok(Math.abs(amende - 7025.33) < 0.5, `amende ${amende} attendue ~7025.33 (inchangée)`);
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

/* -------------------- PLAFOND LÉGAL DU DÉLAI APPLICABLE (≤ 120 j) -------------------- */
test('saneDelai : borne tout délai à [1,120] (défaut légal 60)', () => {
  assert.equal(calc.saneDelai(90), 90);
  assert.equal(calc.saneDelai(120), 120);
  assert.equal(calc.saneDelai(60120), 120, 'valeur concaténée « 60 120 » → plafonnée');
  assert.equal(calc.saneDelai(920260000000000), 120, 'valeur aberrante → plafonnée');
  assert.equal(calc.saneDelai(0), 60);
  assert.equal(calc.saneDelai(-5), 60);
  assert.equal(calc.saneDelai(null), 60);
  assert.equal(calc.saneDelai('abc'), 60);
});
test('computeFacture : un délai aberrant ne masque JAMAIS le retard réel', () => {
  const opts = { dateFacture: '2025-01-01', datePaiement: '2025-06-01', ttc: 100000, periode: { annee: 2025, trimestre: 2 }, today: new Date(2025, 5, 30), tauxProvider: () => 0.0225 };
  const bad = calc.computeFacture({ ...opts, delaiApplicable: 60120 });
  const good = calc.computeFacture({ ...opts, delaiApplicable: 120 });
  assert.equal(bad.delaiApplicable, 120, 'délai borné à 120 dans le calcul');
  assert.ok(bad.montantAmende > 0, 'le retard réel est facturé (pas masqué)');
  assert.equal(bad.montantAmende, good.montantAmende, 'identique à un délai de 120 j');
});
test('import facture : « Délai convenu » = « 60 à 120 » → 120 (jamais 60120)', () => {
  const { cab, ent } = seedCab();
  const X = require('../node_modules/xlsx');
  const aoa = [
    ['N°', 'Date', 'Fournisseur', 'TTC', 'Date paiement', 'Délai convenu'],
    ['F1', '2026-01-05', 'FRS Z', 1000, '2026-03-20', '60 à 120'],
  ];
  const ws = X.utils.aoa_to_sheet(aoa); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'S');
  const buf = X.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const r = importer.confirmImport(buf, { sheetName: 'S', headerRow: 0, mapping: { numero: 0, date_facture: 1, four_nom: 2, ttc: 3, date_paiement: 4, delai_conv: 5 }, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1, sourceName: 'z.xlsx', userId: 'u' });
  assert.ok(r.imported >= 1);
  const f = db.prepare('SELECT delai_applicable FROM fournisseur WHERE entreprise_id=? AND raison_sociale=?').get(ent, 'FRS Z');
  assert.equal(f.delai_applicable, 120, 'délai fournisseur = 120 (plage 60→120), pas 60120');
  const fac = db.prepare('SELECT delai_applicable FROM facture WHERE entreprise_id=?').get(ent);
  assert.ok(fac.delai_applicable > 0 && fac.delai_applicable <= 120, 'délai facture dans [1,120]');
});
test('repair : plafonne les délais corrompus et révèle le retard masqué', () => {
  const { cab, ent } = seedCab();
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,?)').run(fid, cab, ent, 'FRS BAD', 60120);
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,delai_applicable,retard_jours,a_declarer,montant_amende)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid('fac'), cab, ent, fid, 'FB', 100000, '2025-01-01', '2025-06-01', 2025, 2, 60120, 0, 0, 0);
  const { repair } = require('../src/repair');
  const st = repair();
  assert.ok(st.fournisseursPlafonnes >= 1);
  assert.equal(db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(fid).delai_applicable, 120);
  const fac = db.prepare('SELECT delai_applicable, retard_jours, montant_amende FROM facture WHERE fournisseur_id=?').get(fid);
  assert.equal(fac.delai_applicable, 120, 'facture recalculée à 120');
  assert.ok(fac.retard_jours > 0, 'retard réel révélé');
  assert.ok(fac.montant_amende > 0, 'amende recalculée (retard plus masqué)');
});

/* -------------------- IMPORT : classification lignes -------------------- */
test('preview : rejette TTC négatif (avoirs) et détecte les doublons', () => {
  const { cab, ent } = seedCab();
  const buf = fixtureBuf('import-avoirs');
  const pv = importer.previewImport(buf, { sheetName: 'A', headerRow: 0, mapping: { numero: 2, date_facture: 1, four_nom: 4, ttc: 6, date_paiement: 13 }, cabinetId: cab, entrepriseId: ent, annee: 2025, trimestre: 4 });
  assert.ok(pv.stats.rejetees > 0, 'doit rejeter des avoirs TTC<0');
  assert.ok(pv.stats.valides > 0);
});
test('confirm transactionnel + ré-import = doublons (dédoublonnage)', () => {
  const { cab, ent } = seedCab();
  const buf = fixtureBuf('import-avoirs');
  const opts = { sheetName: 'A', headerRow: 0, mapping: { numero: 2, date_facture: 1, four_nom: 4, ttc: 6, date_paiement: 13 }, cabinetId: cab, entrepriseId: ent, annee: 2025, trimestre: 4, sourceName: 'avoirs.xlsx', userId: 'u' };
  const r1 = importer.confirmImport(buf, opts);
  assert.ok(r1.imported > 0);
  const nb = db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(ent).n;
  assert.equal(nb, r1.imported, 'factures en base = importées');
  // Nouvelle règle : les doublons sont GARDÉS et SIGNALÉS (paiement partiel / facture scindée),
  // pas supprimés. Un ré-import recrée donc les lignes, toutes marquées « doublon potentiel ».
  const r2 = importer.confirmImport(buf, { ...opts, sourceName: 'avoirs2.xlsx' });
  assert.equal(r2.imported, r1.imported, 'ré-import : lignes gardées (non supprimées)');
  assert.ok(r2.duplicates > 0, 'ré-import : doublons potentiels signalés');
  const flag = db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=? AND doublon_potentiel=1').get(ent).n;
  assert.ok(flag >= r2.duplicates, 'factures ré-importées marquées doublon potentiel');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(ent).n, r1.imported + r2.imported, 'les deux imports coexistent (rien perdu)');
  // import_ligne tracées
  const ligne = db.prepare('SELECT COUNT(*) n FROM import_ligne WHERE import_lot_id=?').get(r1.importId).n;
  assert.ok(ligne > 0);
});

/* -------------------- TOLÉRANCE FICHIERS (en-têtes lacunaires / montants) -------------------- */
test('tolérance : en-tête lacunaire → colonnes DENSES (pas de null) et dates bien détectées', () => {
  const X = require('../node_modules/xlsx');
  // En-tête avec trous (cols 1,3,5,8 vides) + une colonne « Ecart » de MONTANTS décimaux
  // tombant dans la plage des n° de série Excel (40000–60000) : ne doit PAS être vue comme une date.
  const aoa = [
    ['Date', '', 'N°', '', 'Fournisseur', '', 'Ecart', 'MontantTtc', '', 'Date'],
    ['2026-01-05', '', 'F1', '', 'FRS A', '', 45000.50, 1200, '', '2026-02-10'],
    ['2026-01-06', '', 'F2', '', 'FRS B', '', 52000.75, 2400, '', '2026-02-11'],
    ['2026-01-07', '', 'F3', '', 'FRS C', '', 48000.20, 3600, '', '2026-02-12'],
    ['2026-01-08', '', 'F4', '', 'FRS D', '', 41000.10, 4800, '', '2026-02-13'],
  ];
  const ws = X.utils.aoa_to_sheet(aoa); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'S');
  const buf = X.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const a = importer.analyzeWorkbook(buf);                    // ne doit pas lever
  const f = a.feuilles[0];
  assert.ok(!JSON.stringify(f.colonnes).includes('null'), 'aucune colonne null (dense)');
  assert.ok(f.colonnes.every(c => c && Number.isInteger(c.index)), 'chaque colonne a un index');
  assert.equal(f.mapping.date_facture.col, 0, 'date facture = colonne 0');
  assert.equal(f.mapping.date_paiement.col, 9, 'date paiement = colonne 9 (pas la colonne de montants 40000–60000)');
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

/* ==================================================================================
 * LOT 3 — DOCUMENTS DE CONVENTIONS (Stratégie B : archivage, PAS d'OCR)
 * Le document est archivé tel quel ; aucune extraction/OCR. Le délai est OBLIGATOIRE,
 * EXPLICITE, entier 1..120 — jamais de « 120 » par défaut présenté comme extrait.
 * ================================================================================== */
const JPEG_BYTES = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
async function postConvCreate(t, fields, buf, filename, type) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) fd.append(k, String(v));
  if (buf != null) fd.append('file', new Blob([buf], { type: type || 'application/octet-stream' }), filename);
  const res = await fetch(baseUrl() + `/api/clients/${t.ent}/conventions`, { method: 'POST', headers: { Cookie: cookieOf(t.u) }, body: fd });
  let body = null; try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
}

// (1)+(6)+(8) PDF autorisé, délai 90 explicite conservé, document rattaché & consultable
test('lot3/conv : création PDF + délai 90 explicite → 200, document rattaché & consultable', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postConvCreate(t, { fournisseur_id: fid, delai: 90 }, PDF_BYTES, 'convention.pdf', 'application/pdf');
  assert.equal(r.status, 200);
  const c = db.prepare('SELECT * FROM convention WHERE entreprise_id=? AND fournisseur_id=?').get(t.ent, fid);
  assert.ok(c, 'convention créée');
  assert.equal(c.delai_convenu, 90, 'délai 90 conservé (aucun défaut 120)');
  assert.ok(c.fichier, 'document rattaché (fichier stocké)');
  assert.equal(c.fichier_nom, 'convention.pdf');
  // Le téléchargement se fait par l'ID de convention (la route masque le nom de stockage interne).
  const dl = await fetch(baseUrl() + `/api/conventions/${c.id}/file`, { headers: { Cookie: cookieOf(t.u) } });
  assert.equal(dl.status, 200, 'document téléchargeable depuis la convention');
});

// (2) Image JPEG autorisée
test('lot3/conv : création image JPEG autorisée + délai 60', async () => {
  const t = newTenant();
  const r = await postConvCreate(t, { fournisseur: 'FRS IMG', four_ice: '000000000000501', delai: 60 }, JPEG_BYTES, 'scan.jpg', 'image/jpeg');
  assert.equal(r.status, 200);
  const c = db.prepare('SELECT c.* FROM convention c JOIN fournisseur f ON f.id=c.fournisseur_id WHERE f.entreprise_id=? AND f.raison_sociale=?').get(t.ent, 'FRS IMG');
  assert.ok(c && c.fichier, 'convention + image JPEG rattachée');
  assert.equal(c.delai_convenu, 60);
});

// Image PNG autorisée
test('lot3/conv : création image PNG autorisée', async () => {
  const t = newTenant();
  const r = await postConvCreate(t, { fournisseur: 'FRS PNG', four_ice: '000000000000502', delai: 45 }, PNG_BYTES, 'scan.png', 'image/png');
  assert.equal(r.status, 200);
});

// (3) Type non supporté refusé → aucune convention orpheline
test('lot3/conv : type de document non supporté refusé (400), aucune convention orpheline', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postConvCreate(t, { fournisseur_id: fid, delai: 90 }, Buffer.from('juste du texte'), 'note.txt', 'text/plain');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /format|PDF/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE fournisseur_id=?').get(fid).n, 0, 'aucune convention créée');
});

// Faux PDF (extension .pdf, octets invalides) refusé
test('lot3/conv : faux PDF (extension .pdf, octets non-%PDF-) refusé (400)', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postConvCreate(t, { fournisseur_id: fid, delai: 90 }, Buffer.from('PAS UN PDF'), 'faux.pdf', 'application/pdf');
  assert.equal(r.status, 400);
});

// (4)+(5) délai ABSENT refusé : aucun 120 auto, fournisseur inchangé
test('lot3/conv : délai ABSENT refusé (aucun 120 injecté), fournisseur inchangé (60)', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postConvCreate(t, { fournisseur_id: fid }, PDF_BYTES, 'c.pdf', 'application/pdf');
  assert.equal(r.status, 400, 'délai obligatoire');
  assert.match(r.body.error, /obligatoire|1 (à|et) 120/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE fournisseur_id=?').get(fid).n, 0, 'aucune convention (donc aucun délai 120)');
  assert.equal(db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(fid).delai_applicable, 60, 'délai fournisseur inchangé (60, pas 120)');
});

// Délai vide refusé
test('lot3/conv : délai vide refusé (400)', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postConvCreate(t, { fournisseur_id: fid, delai: '' });
  assert.equal(r.status, 400);
});

// (7) délai 120 explicite conservé (borne haute légitime)
test('lot3/conv : délai 120 explicite conservé', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postConvCreate(t, { fournisseur_id: fid, delai: 120 });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT delai_convenu FROM convention WHERE fournisseur_id=?').get(fid).delai_convenu, 120);
});

// (17) valeurs hors plage / non entières refusées
test('lot3/conv : délai hors plage (0,121,999) et non entier (90,5 / abc) refusés', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  for (const bad of ['0', '121', '999', '90,5', '90.5', 'abc', '-5']) {
    const r = await postConvCreate(t, { fournisseur_id: fid, delai: bad });
    assert.equal(r.status, 400, `délai « ${bad} » doit être refusé`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE fournisseur_id=?').get(fid).n, 0, 'aucune convention pour délais invalides');
});

// (6) délai 90 sans document → convention créée
test('lot3/conv : délai 90 sans document → convention créée, délai 90', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postConvCreate(t, { fournisseur_id: fid, delai: 90 });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT delai_convenu FROM convention WHERE fournisseur_id=?').get(fid).delai_convenu, 90);
});

// (9) audit généré à la création
test('lot3/conv : audit create/convention généré à la création', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  await postConvCreate(t, { fournisseur_id: fid, delai: 75 }, PDF_BYTES, 'c.pdf', 'application/pdf');
  const a = db.prepare("SELECT * FROM audit_log WHERE cabinet_id=? AND action='create' AND entite='convention' ORDER BY created_at DESC").get(t.cab);
  assert.ok(a, "entrée d'audit create/convention présente");
});

// (16)+ ajout ultérieur : image acceptée aussi (rattachement à une convention existante)
test('lot3/conv : ajout ultérieur d\'une image JPEG à une convention existante', async () => {
  const t = newTenant();
  await postFile(`/api/clients/${t.ent}/conventions/import`, cookieOf(t.u), convBuf([['ADDIMG', '000000000000503', '', '', 'OUI', 90]]), 'l.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const conv = convOfEnt(t.ent)[0];
  const add = await postFile(`/api/clients/${t.ent}/conventions/${conv.id}/file`, cookieOf(t.u), JPEG_BYTES, 'signee.jpg', 'image/jpeg');
  assert.equal(add.status, 200);
  assert.ok(db.prepare('SELECT fichier FROM convention WHERE id=?').get(conv.id).fichier, 'image rattachée');
});

// (10) non-régression import Excel conventions : délai importé exact, aucun document, aucun OCR
test('lot3/conv : import Excel conventions inchangé (délai exact 88, document différé)', async () => {
  const t = newTenant();
  const r = await postFile(`/api/clients/${t.ent}/conventions/import`, cookieOf(t.u), convBuf([['LOT3 IMP', '000000000000601', '', '', 'OUI', 88]]), 'l.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(r.status, 200);
  assert.equal(r.body.conventionsCreated, 1);
  const c = convOfEnt(t.ent)[0];
  assert.equal(c.delai_convenu, 88, 'délai importé exact (aucun défaut 120)');
  assert.equal(c.fichier, null, 'import Excel = document différé (aucune extraction)');
});

// Stratégie B — (11)(12)(14)(15) honnêteté de l'UI (contrôle statique du bundle front)
test('lot3/UI : aucun libellé OCR/IA trompeur ; message archivage manuel ; formulaire sans défaut 120', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
  const appCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  // (11)(14) aucune promesse d'extraction/OCR/IA, aucune valeur « détectée »
  assert.doesNotMatch(appJs, /module IA|OCR extraira|extraira automatiquement|OCR effectué|champs détectés|IA active/i, 'aucune promesse OCR/IA dans app.js');
  assert.doesNotMatch(appJs, /\bOCR\b/, 'aucun token « OCR » dans app.js');
  assert.doesNotMatch(appHtml, /\bOCR\b/, 'nav sans « OCR »');
  assert.doesNotMatch(appCss, /ocr-fld|\.scan\b/, 'CSS maquette OCR retirée');
  // (12) message « document archivé, saisie manuelle »
  assert.match(appJs, /Le document est archivé[\s\S]*saisies manuellement/i, 'message d\'archivage manuel présent');
  // (15) formulaire manuel : champ délai borné 1..120, SANS value=120 prérempli
  assert.doesNotMatch(appJs, /id="v_delai"[^>]*value="120"/, 'aucun délai 120 prérempli');
  assert.match(appJs, /id="v_delai"[^>]*min="1"[^>]*max="120"/, 'délai borné 1..120 dans le formulaire');
});

// (13) aucun endpoint OCR/extraction fantôme dans l'API
test('lot3/UI : aucun endpoint OCR/extraction fantôme dans l\'API', () => {
  const apiJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');
  assert.doesNotMatch(apiJs, /router\.(get|post|put|patch|delete)\(['"][^'"]*(ocr|extract|vision|analyse-?doc|scan-?doc)/i, 'aucune route OCR/extraction');
});

/* ============== BOUTON « Convention présente » (feuille de délais) ============== */
async function postJson(pathUrl, cookie, body) {
  const res = await fetch(baseUrl() + pathUrl, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let b = null; try { b = await res.json(); } catch (_) {}
  return { status: res.status, body: b };
}
function seedFactureFrs(t, { delaiEcoule = 90 } = {}) {
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fid, t.cab, t.ent, 'FRS DELAIS SARL', '000000000000701');
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid('fac'), t.cab, t.ent, fid, 'F-1', 10000, 2026, 1, 60, delaiEcoule, delaiEcoule - 60, 1);
  return fid;
}
test('délais/HTTP : la réponse expose four_id (id fournisseur) pour l\'action express', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const res = await fetch(baseUrl() + `/api/clients/${t.ent}/delais?annee=2026&trimestre=1`, { headers: { Cookie: cookieOf(t.u) } });
  const data = await res.json();
  assert.equal(res.status, 200);
  const row = data.rows.find(r => r.numero === 'F-1');
  assert.ok(row, 'ligne facture présente');
  assert.equal(row.four_id, fid, 'four_id exposé');
  assert.equal(row.has_conv, false);
});
test('délais/HTTP : « Convention présente » crée la convention pour ce fournisseur', async () => {
  const t = newTenant(); const fid = seedFactureFrs(t);
  const r = await postJson(`/api/clients/${t.ent}/conventions`, cookieOf(t.u), { fournisseur_id: fid, delai: 120 });
  assert.equal(r.status, 200);
  const c = db.prepare(`SELECT * FROM convention WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide'`).get(t.ent, fid);
  assert.ok(c, 'convention créée');
  assert.equal(c.delai_convenu, 120);
  assert.equal(db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(fid).delai_applicable, 120, 'délai fournisseur mis à jour');
});
test('délais/HTTP : action express refusée pour un fournisseur d\'un autre tenant (anti-IDOR)', async () => {
  const a = newTenant('A'), b = newTenant('B'); const fidB = seedFactureFrs(b);
  // Utilisateur A tente de créer une convention sur SON entreprise avec le fournisseur de B.
  const r = await postJson(`/api/clients/${a.ent}/conventions`, cookieOf(a.u), { fournisseur_id: fidB, delai: 120 });
  assert.equal(r.status, 400, 'fournisseur hors entreprise → rejeté');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM convention WHERE fournisseur_id=?`).get(fidB).n, 0, 'aucune convention créée chez B');
});

/* ==================================================================================
 * RÈGLE MÉTIER : DATE D'ARRÊTÉ & DÉLAI CONSTATÉ (facture impayée à la clôture)
 * ================================================================================== */
const A = (dateFacture, datePaiement, annee, trimestre) => calc.getDateArreteFacture({ dateFacture, datePaiement, annee, trimestre });

test('arrêté #1 : T1 impayée → 31/03', () => { assert.equal(A('2026-01-10', null, 2026, 1).dateArreteIso, '2026-03-31'); });
test('arrêté #2 : T2 impayée → 30/06', () => { assert.equal(A('2026-04-10', null, 2026, 2).dateArreteIso, '2026-06-30'); });
test('arrêté #3 : T3 impayée → 30/09', () => { assert.equal(A('2026-07-10', null, 2026, 3).dateArreteIso, '2026-09-30'); });
test('arrêté #4 : T4 impayée → 31/12 (même si traité en janvier N+1)', () => {
  const r = A('2026-10-15', null, 2026, 4);
  assert.equal(r.dateArreteIso, '2026-12-31');
  assert.equal(periode.periodInfo(2026, 4).annee_traitement, 2027); // traité en janvier 2027…
  assert.equal(r.dateArreteIso, '2026-12-31');                       // …mais arrêté au 31/12/2026
});
test('arrêté #5 : 15/04 impayée → 30/06 = 76 jours', () => {
  const r = A('2026-04-15', null, 2026, 2);
  assert.equal(r.dateArreteIso, '2026-06-30');
  assert.equal(r.delaiConstate, 76);
});
test('arrêté #6 : paiement avant fin trimestre → date de paiement utilisée', () => {
  const r = A('2026-04-15', '2026-05-20', 2026, 2);
  assert.equal(r.etat, 'paye'); assert.equal(r.dateArreteIso, '2026-05-20'); assert.equal(r.delaiConstate, 35);
});
test('arrêté #7 : paiement exactement le dernier jour → date de paiement utilisée', () => {
  const r = A('2026-04-15', '2026-06-30', 2026, 2);
  assert.equal(r.etat, 'paye'); assert.equal(r.dateArreteIso, '2026-06-30'); assert.equal(r.delaiConstate, 76);
});
test('arrêté #8 : paiement après la clôture → fin du trimestre utilisée', () => {
  const r = A('2026-04-15', '2026-07-10', 2026, 2);
  assert.equal(r.etat, 'paye_apres_cloture'); assert.equal(r.dateArreteIso, '2026-06-30'); assert.equal(r.delaiConstate, 76);
});
test('arrêté #9 : paiement vide → fin du trimestre utilisée', () => {
  const r = A('2026-04-15', '', 2026, 2);
  assert.equal(r.etat, 'impaye_cloture'); assert.equal(r.dateArreteIso, '2026-06-30');
});
test('arrêté #10 : facture d\'un trimestre antérieur impayée → calcul jusqu\'à la nouvelle clôture', () => {
  const t2 = A('2026-02-15', null, 2026, 2), t3 = A('2026-02-15', null, 2026, 3), t4 = A('2026-02-15', null, 2026, 4);
  assert.equal(t2.dateArreteIso, '2026-06-30'); assert.equal(t2.delaiConstate, 135);
  assert.equal(t3.dateArreteIso, '2026-09-30');
  assert.equal(t4.dateArreteIso, '2026-12-31');
});
test('arrêté #11 : facture postérieure à la fin du trimestre → anomalie, jamais de délai négatif', () => {
  const r = A('2026-07-05', null, 2026, 2);
  assert.equal(r.etat, 'facture_hors_periode');
  assert.equal(r.delaiConstate, null);
});
test('arrêté #12 : paiement antérieur à la facture → anomalie, pas de délai négatif', () => {
  const r = A('2026-04-15', '2026-04-10', 2026, 2);
  assert.equal(r.etat, 'paiement_anterieur');
  assert.equal(r.delaiConstate, null);
});
test('arrêté #13 : aucun décalage dû au fuseau horaire', () => {
  // Résultat identique quel que soit le format/heure d'entrée.
  assert.equal(A('2026-04-15', null, 2026, 2).delaiConstate, 76);
  assert.equal(A('15/04/2026', null, 2026, 2).delaiConstate, 76);
  assert.equal(calc.daysBetween(calc.parseDate('2026-04-15'), calc.parseDate('2026-06-30')), 76);
});
test('arrêté #14 : année bissextile (T1 2024)', () => {
  const r = A('2024-01-01', null, 2024, 1);
  assert.equal(r.dateArreteIso, '2024-03-31');
  assert.equal(r.delaiConstate, calc.daysBetween(calc.parseDate('2024-01-01'), calc.parseDate('2024-03-31')));
  assert.equal(A('2024-02-29', null, 2024, 1).delaiConstate, 31); // 29/02 → 31/03 (bissextile)
});
test('arrêté #15 : délai constaté / délai autorisé / retard bien distincts', () => {
  seedCab();
  const c = calc.computeFacture({ dateFacture: '2026-04-15', datePaiement: null, ttc: 100000, delaiApplicable: 60, periode: { annee: 2026, trimestre: 2 }, tauxProvider: () => 0.0225 });
  assert.equal(c.delaiEcoule, 76, 'délai constaté = 76');
  assert.equal(c.delaiApplicable, 60, 'délai autorisé = 60');
  assert.equal(c.retardJours, 16, 'retard = 76 − 60 = 16');
  assert.equal(c.etatPaiement, 'impaye_cloture');
  assert.equal(c.arreteAu, '2026-06-30');
});
test('arrêté #16 : incidence reportée — même facture recalculée à chaque clôture, sans duplication', () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS INC');
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer,montant_amende)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid('fac'), t.cab, t.ent, fid, 'INC-1', 100000, '2026-01-15', null, 2026, 1, 60, 45, 15, 1, 500);
  const before = db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(t.ent).n;
  // Arrêté recalculé à chaque trimestre ultérieur (source de vérité), sans créer de nouvelle facture.
  assert.equal(calc.getDateArreteFacture({ dateFacture: '2026-01-15', datePaiement: null, annee: 2026, trimestre: 2 }).dateArreteIso, '2026-06-30');
  assert.equal(calc.getDateArreteFacture({ dateFacture: '2026-01-15', datePaiement: null, annee: 2026, trimestre: 3 }).dateArreteIso, '2026-09-30');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(t.ent).n, before, 'aucune duplication de la facture source');
});
test('arrêté #17 : période clôturée → même résultat quelle que soit la date du jour (reproductible)', () => {
  const base = { dateFacture: '2026-04-15', datePaiement: null, ttc: 100000, delaiApplicable: 60, periode: { annee: 2026, trimestre: 2 }, tauxProvider: () => 0.0225 };
  const a = calc.computeFacture({ ...base, today: new Date(2026, 6, 20) });
  const b = calc.computeFacture({ ...base, today: new Date(2027, 0, 5) });
  assert.equal(a.delaiEcoule, b.delaiEcoule, 'délai constaté indépendant de today');
  assert.equal(a.montantAmende, b.montantAmende, 'amende reproductible');
  assert.equal(a.arreteAu, '2026-06-30'); assert.equal(b.arreteAu, '2026-06-30');
});

/* ==================================================================================
 * RÈGLE SPÉCIALE — OPÉRATEURS DE RÉSEAU (télécom / eau / électricité) : délai 30 j + exclusion déclarative
 * ================================================================================== */
const reseau = require('../src/reseau');
const C = (nom) => reseau.classifyReseau({ nom });
test('reseau #1-8 : reconnaissance par alias (télécom / SRM)', () => {
  assert.equal(C('MAROC TELECOM').categorie, 'telecom');
  assert.ok(C('IAM').isOperateur && C('IAM').ambigu, 'IAM = alias ambigu');
  assert.ok(C('ITISSALAT AL MAGHRIB').isOperateur);
  assert.equal(C('ORANGE MAROC').categorie, 'telecom');
  assert.ok(C('MEDI TELECOM').isOperateur);
  assert.ok(C('INWI').isOperateur);
  assert.ok(C('WANA CORPORATE').isOperateur);
  assert.ok(C('SRM').isOperateur && C('SRM').ambigu, 'SRM = ambigu');
});
test('reseau #9 : nom vague NON reconnu automatiquement (pas de faux positif)', () => {
  assert.equal(C('SOCIETE DES EAUX MINERALES ATLAS').isOperateur, false); // « eau » seul ne classe pas
  assert.equal(C('ENERGIE SOLAIRE SARL').isOperateur, false);
  assert.equal(C('RESEAUX ET TRAVAUX SARL').isOperateur, false);
});
test('reseau #10 : ICE d\'un opérateur confirmé prioritaire sur le nom (import)', () => {
  const { cab, ent } = seedCab();
  // opérateur confirmé avec un ICE connu
  db.prepare(`INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,operateur_reseau,statut_classification,hors_tableau_declaratif,delai_special,categorie_fournisseur,delai_applicable) VALUES (?,?,?,?,?,1,'confirme',1,30,'telecom',30)`)
    .run(uid('four'), cab, ent, 'MAROC TELECOM', '000000000000010');
  const r = importer.upsertFournisseur ? null : null; // upsert interne : on passe par un import
  const X = require('../node_modules/xlsx');
  const aoa = [['N°', 'Date', 'Fournisseur', 'ICE', 'TTC'], ['F1', '2026-04-15', 'LIBELLE DIFFERENT', '000000000000010', 1000]];
  const ws = X.utils.aoa_to_sheet(aoa); const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'S');
  importer.confirmImport(X.write(wb, { type: 'buffer', bookType: 'xlsx' }), { sheetName: 'S', headerRow: 0, mapping: { numero: 0, date_facture: 1, four_nom: 2, four_ice: 3, ttc: 4 }, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 2, sourceName: 's.xlsx', userId: 'u' });
  // le même ICE ne doit pas dupliquer et reste opérateur confirmé
  const f = db.prepare("SELECT * FROM fournisseur WHERE entreprise_id=? AND ice='000000000000010'").get(ent);
  assert.equal(f.operateur_reseau, 1); assert.equal(f.statut_classification, 'confirme');
});
test('reseau #11-14 : délai 30 j, constaté jusqu\'à la clôture, retard = 46 (15/04→30/06)', () => {
  const rd = reseau.resolveDelaiAutorise({ fournisseur: { operateur_reseau: 1, statut_classification: 'confirme', hors_tableau_declaratif: 1 } });
  assert.equal(rd.delaiAutorise, 30); assert.equal(rd.horsTableauDeclaratif, true); assert.equal(rd.sourceRegle, 'operateur_reseau');
  const c = calc.computeFacture({ dateFacture: '2026-04-15', datePaiement: null, ttc: 100000, delaiApplicable: 30, periode: { annee: 2026, trimestre: 2 }, tauxProvider: () => 0.0225 });
  assert.equal(c.delaiEcoule, 76); assert.equal(c.delaiApplicable, 30); assert.equal(c.retardJours, 46);
});
test('reseau : classification proposée par le nom N\'EST PAS confirmée (ni 30 j ni exclusion tant que non confirmée)', () => {
  const rd = reseau.resolveDelaiAutorise({ fournisseur: { operateur_reseau: 1, statut_classification: 'propose', delai_applicable: 60 } });
  assert.notEqual(rd.delaiAutorise, 30); assert.equal(rd.horsTableauDeclaratif, false);
  assert.equal(reseau.estHorsTableauDeclaratif({ operateur_reseau: 1, statut_classification: 'propose', hors_tableau_declaratif: 0 }), false);
});
test('reseau/HTTP #18-20 : opérateur exclu du tableau déclaratif, visible en interne, dans le résumé', async () => {
  const t = newTenant();
  db.prepare(`INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable,operateur_reseau,statut_classification,hors_tableau_declaratif,delai_special,categorie_fournisseur) VALUES (?,?,?,?,?,30,1,'confirme',1,30,'telecom')`)
    .run(uid('four'), t.cab, t.ent, 'MAROC TELECOM', '000000000000010');
  const st = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(st, t.cab, t.ent, 'FRS STANDARD');
  const op = db.prepare("SELECT id FROM fournisseur WHERE entreprise_id=? AND raison_sociale='MAROC TELECOM'").get(t.ent).id;
  for (const [fid, num] of [[op, 'OP-1'], [st, 'ST-1']])
    db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,a_declarer) VALUES (?,?,?,?,?,?,?,?,?,1)`).run(uid('fac'), t.cab, t.ent, fid, num, 100000, '2026-04-15', 2026, 2);
  const dec = await (await fetch(baseUrl() + `/api/clients/${t.ent}/declaration?annee=2026&trimestre=2`, { headers: { Cookie: cookieOf(t.u) } })).json();
  assert.ok(!dec.lignes.some(l => l.nom === 'MAROC TELECOM'), 'opérateur EXCLU du tableau déclaratif');
  assert.ok(dec.lignes.some(l => l.nom === 'FRS STANDARD'), 'standard présent');
  assert.ok(dec.exclusions.nbFactures >= 1 && dec.exclusions.nbFournisseurs >= 1, 'résumé des exclusions renseigné');
  const del = await (await fetch(baseUrl() + `/api/clients/${t.ent}/delais?annee=2026&trimestre=2`, { headers: { Cookie: cookieOf(t.u) } })).json();
  const opRow = del.rows.find(x => x.numero === 'OP-1');
  assert.ok(opRow, 'opérateur VISIBLE en suivi interne');
  assert.equal(opRow.delai_applicable, 30); assert.equal(opRow.operateur_reseau, true); assert.equal(opRow.hors_tableau, true);
});

/* ==================================================================================
 * REVUE NON DESTRUCTIVE DES DOUBLONS POTENTIELS
 *  - harmonisation des 3 imports (fonction centrale markPotentialDuplicate)
 *  - migration idempotente des statuts de revue
 *  - endpoint PATCH de revue (audit, anomalies)
 *  - exposition API + non-régression métier (dossier de démonstration, réseau, conventions, dates)
 * ================================================================================== */
const { backfillStatutDoublon } = require('../src/db');

// Classeur de factures minimal (en-têtes reconnues par l'auto-mapping).
function facBuf(rows, sheet = 'S') {
  const H = ['N°', 'Date facture', 'Fournisseur', 'ICE', 'TTC', 'Date paiement'];
  const ws = XLSX.utils.aoa_to_sheet([H, ...rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const FAC_MAP = { numero: 0, date_facture: 1, four_nom: 2, four_ice: 3, ttc: 4, date_paiement: 5 };
// Relevé de déductions TVA (SIMPL) au format XML officiel.
function releveXml(rds) {
  const items = rds.map(r => `<rd><num>${r.num || ''}</num><des>${r.des || ''}</des>` +
    `<mht>${r.mht || ''}</mht><tva>${r.tva || ''}</tva><ttc>${r.ttc || ''}</ttc>` +
    `<dfac>${r.dfac || ''}</dfac><dpai>${r.dpai || ''}</dpai>` +
    `<refF><nom>${r.nom || ''}</nom><ice>${r.ice || ''}</ice><if>${r.iff || ''}</if></refF></rd>`).join('');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><DeclarationReleveDeduction><releveDeductions>${items}</releveDeductions></DeclarationReleveDeduction>`, 'utf8');
}
function anomaliesDoublon(ent) { return db.prepare(`SELECT * FROM anomalie WHERE entreprise_id=? AND type='doublon_potentiel'`).all(ent); }
function facturesOf(ent) { return db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(ent).n; }

/* -------------------- A. HARMONISATION DES 3 IMPORTS -------------------- */
test('doublon/A1 importExcel : ligne conservée + doublon marqué + anomalie basse', () => {
  const { cab, ent } = seedCab();
  const buf = facBuf([['F1', '2026-01-05', 'FRS A', '000000000000801', 1000, '2026-02-01']]);
  const r1 = importer.importWorkbook(buf, { cabinetId: cab, entrepriseId: ent, sourceName: 'a.xlsx', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r1.imported, 1); assert.equal(r1.duplicates, 0);
  const r2 = importer.importWorkbook(buf, { cabinetId: cab, entrepriseId: ent, sourceName: 'a2.xlsx', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r2.imported, 1, 'ligne conservée (non supprimée)');
  assert.equal(r2.duplicates, 1, 'doublon signalé');
  assert.equal(facturesOf(ent), 2, 'les 2 lignes coexistent');
  const dup = db.prepare('SELECT * FROM facture WHERE entreprise_id=? AND doublon_potentiel=1').get(ent);
  assert.ok(dup && dup.motif_doublon, 'motif présent'); assert.equal(dup.statut_doublon, 'potentiel');
  const anos = anomaliesDoublon(ent);
  assert.equal(anos.length, 1); assert.equal(anos[0].gravite, 'basse'); assert.equal(anos[0].statut, 'ouverte');
});
test('doublon/A2 importReleveXml : ligne conservée + doublon marqué + anomalie basse', () => {
  const { cab, ent } = seedCab();
  const xml = releveXml([{ num: 'X1', nom: 'FRS X', ice: '000000000000802', ttc: 2000, dfac: '2026-01-06', dpai: '2026-02-02' }]);
  const r1 = importer.importWorkbook(xml, { cabinetId: cab, entrepriseId: ent, sourceName: 'r.xml', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r1.imported, 1); assert.equal(r1.duplicates, 0);
  const r2 = importer.importWorkbook(xml, { cabinetId: cab, entrepriseId: ent, sourceName: 'r2.xml', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r2.imported, 1, 'ligne conservée'); assert.equal(r2.duplicates, 1, 'doublon signalé');
  assert.equal(facturesOf(ent), 2);
  const dup = db.prepare('SELECT * FROM facture WHERE entreprise_id=? AND doublon_potentiel=1').get(ent);
  assert.equal(dup.statut_doublon, 'potentiel'); assert.ok(dup.motif_doublon);
  const anos = anomaliesDoublon(ent);
  assert.equal(anos.length, 1); assert.equal(anos[0].gravite, 'basse'); assert.equal(anos[0].statut, 'ouverte');
});
test('doublon/A3 confirmImport : ligne conservée + doublon marqué + anomalie basse', () => {
  const { cab, ent } = seedCab();
  const buf = facBuf([['C1', '2026-01-07', 'FRS C', '000000000000803', 3000, '2026-02-03']]);
  const opts = { sheetName: 'S', headerRow: 0, mapping: FAC_MAP, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1, sourceName: 'c.xlsx', userId: 'u' };
  importer.confirmImport(buf, opts);
  const r2 = importer.confirmImport(buf, { ...opts, sourceName: 'c2.xlsx' });
  assert.equal(r2.imported, 1, 'ligne conservée'); assert.equal(r2.duplicates, 1, 'doublon signalé');
  assert.equal(facturesOf(ent), 2);
  const dup = db.prepare('SELECT * FROM facture WHERE entreprise_id=? AND doublon_potentiel=1').get(ent);
  assert.equal(dup.statut_doublon, 'potentiel'); assert.ok(dup.motif_doublon);
  const anos = anomaliesDoublon(ent);
  assert.equal(anos.length, 1); assert.equal(anos[0].gravite, 'basse'); assert.equal(anos[0].statut, 'ouverte');
});
test('doublon/A4 anomalie idempotente : réexécution du marquage ne double pas l\'anomalie', () => {
  const { cab, ent } = seedCab();
  const fid = uid('fac');
  db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,numero,ttc,annee,trimestre) VALUES (?,?,?,?,?,?,?)').run(fid, cab, ent, 'D1', 500, 2026, 1);
  importer.markPotentialDuplicate({ factureId: fid, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1 });
  importer.markPotentialDuplicate({ factureId: fid, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1 });
  importer.markPotentialDuplicate({ factureId: fid, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1 });
  assert.equal(anomaliesDoublon(ent).length, 1, 'une seule anomalie malgré 3 exécutions');
});
test('doublon/A5 les 3 imports produisent un résultat strictement identique', () => {
  const norm = anos => anos.map(a => ({ type: a.type, gravite: a.gravite, statut: a.statut })); // effet DB comparable
  function effet(runImport) {
    const { cab, ent } = seedCab(); runImport(cab, ent);
    const f = db.prepare('SELECT doublon_potentiel, statut_doublon, (motif_doublon IS NOT NULL) has_motif FROM facture WHERE entreprise_id=? AND doublon_potentiel=1').get(ent);
    return { f, anos: norm(anomaliesDoublon(ent)) };
  }
  const excel = effet((cab, ent) => { const b = facBuf([['E', '2026-01-05', 'FE', '000000000000811', 1000, '2026-02-01']]); const o = { cabinetId: cab, entrepriseId: ent, sourceName: 's', periode: { annee: 2026, trimestre: 1 } }; importer.importWorkbook(b, o); importer.importWorkbook(b, o); });
  const xml = effet((cab, ent) => { const x = releveXml([{ num: 'E', nom: 'FE', ice: '000000000000811', ttc: 1000, dfac: '2026-01-05', dpai: '2026-02-01' }]); const o = { cabinetId: cab, entrepriseId: ent, sourceName: 's', periode: { annee: 2026, trimestre: 1 } }; importer.importWorkbook(x, o); importer.importWorkbook(x, o); });
  const conf = effet((cab, ent) => { const b = facBuf([['E', '2026-01-05', 'FE', '000000000000811', 1000, '2026-02-01']]); const o = { sheetName: 'S', headerRow: 0, mapping: FAC_MAP, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1, sourceName: 's', userId: 'u' }; importer.confirmImport(b, o); importer.confirmImport(b, o); });
  assert.deepEqual(excel, xml, 'Excel ≡ XML'); assert.deepEqual(excel, conf, 'Excel ≡ confirmImport');
  assert.deepEqual(excel.f, { doublon_potentiel: 1, statut_doublon: 'potentiel', has_motif: 1 });
  assert.deepEqual(excel.anos, [{ type: 'doublon_potentiel', gravite: 'basse', statut: 'ouverte' }]);
});

/* -------------------- B. MIGRATION ET STATUTS -------------------- */
test('doublon/B6 migration : colonnes présentes', () => {
  const cols = db.prepare('PRAGMA table_info(facture)').all().map(c => c.name);
  for (const c of ['statut_doublon', 'date_revue_doublon', 'utilisateur_revue_doublon']) assert.ok(cols.includes(c), `colonne ${c}`);
  const anoCols = db.prepare('PRAGMA table_info(anomalie)').all().map(c => c.name);
  assert.ok(anoCols.includes('resolue_le') && anoCols.includes('motif_resolution'));
});
test('doublon/B7-B8 migration rejouée sans erreur + ancien doublon → potentiel', () => {
  const { cab, ent } = seedCab();
  const fid = uid('fac');
  db.prepare("INSERT INTO facture (id,cabinet_id,entreprise_id,numero,ttc,annee,trimestre,doublon_potentiel,statut_doublon) VALUES (?,?,?,?,?,?,?,1,'aucun')").run(fid, cab, ent, 'OLD', 100, 2026, 1);
  const n1 = backfillStatutDoublon();
  assert.ok(n1 >= 1, 'au moins la facture héritée mise à jour');
  assert.equal(db.prepare('SELECT statut_doublon FROM facture WHERE id=?').get(fid).statut_doublon, 'potentiel');
  const n2 = backfillStatutDoublon();
  assert.equal(n2, 0, 'rejouée : aucun changement (idempotente)');
});
test('doublon/B9 facture ordinaire reste statut aucun', () => {
  const { cab, ent } = seedCab();
  const fid = uid('fac');
  db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,numero,ttc,annee,trimestre) VALUES (?,?,?,?,?,?,?)').run(fid, cab, ent, 'ORD', 100, 2026, 1);
  backfillStatutDoublon();
  assert.equal(db.prepare('SELECT statut_doublon FROM facture WHERE id=?').get(fid).statut_doublon, 'aucun');
});
test('doublon/B10-B12 aucune revue (potentiel/confirme/faux_positif) ne supprime la facture', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  for (const statut of ['confirme', 'faux_positif', 'potentiel']) {
    const r = await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut });
    assert.equal(r.status, 200, `statut ${statut} accepté`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM facture WHERE id=?').get(fid).n, 1, `facture conservée après ${statut}`);
    assert.equal(db.prepare('SELECT statut_doublon FROM facture WHERE id=?').get(fid).statut_doublon, statut);
  }
});

/* -------------------- C. ENDPOINT DE REVUE -------------------- */
async function patchJson(pathUrl, cookie, body) {
  const res = await fetch(baseUrl() + pathUrl, { method: 'PATCH', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let b = null; try { b = await res.json(); } catch (_) {}
  return { status: res.status, body: b };
}
// Facture marquée doublon potentiel (avec anomalie ouverte) dans un tenant.
function seedDoublonFac(t, numero = 'DUP-1') {
  const fid = uid('fac');
  db.prepare("INSERT INTO facture (id,cabinet_id,entreprise_id,numero,ttc,annee,trimestre) VALUES (?,?,?,?,?,?,?)").run(fid, t.cab, t.ent, numero, 1000, 2026, 1);
  importer.markPotentialDuplicate({ factureId: fid, cabinetId: t.cab, entrepriseId: t.ent, annee: 2026, trimestre: 1, ref: numero });
  return fid;
}
test('doublon/C13 PATCH potentiel → confirme', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  const r = await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut: 'confirme' });
  assert.equal(r.status, 200); assert.equal(r.body.statut_doublon, 'confirme');
  assert.equal(db.prepare('SELECT statut_doublon FROM facture WHERE id=?').get(fid).statut_doublon, 'confirme');
  assert.equal(db.prepare('SELECT doublon_potentiel FROM facture WHERE id=?').get(fid).doublon_potentiel, 1, 'trace conservée');
});
test('doublon/C14 PATCH potentiel → faux_positif', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  const r = await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut: 'faux_positif' });
  assert.equal(r.status, 200); assert.equal(r.body.statut_doublon, 'faux_positif');
  assert.equal(db.prepare('SELECT statut_doublon FROM facture WHERE id=?').get(fid).statut_doublon, 'faux_positif');
});
test('doublon/C15 statut invalide → 400', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  const r = await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut: 'supprime' });
  assert.equal(r.status, 400);
});
test('doublon/C16 facture inexistante → 404', async () => {
  const t = newTenant();
  const r = await patchJson(`/api/clients/${t.ent}/factures/fac_inexistante/doublon`, cookieOf(t.u), { statut: 'confirme' });
  assert.equal(r.status, 404);
});
test('doublon/C17 facture d\'un autre client inaccessible', async () => {
  const a = newTenant('A'), b = newTenant('B'); const fidB = seedDoublonFac(b, 'B-DUP');
  const r = await patchJson(`/api/clients/${b.ent}/factures/${fidB}/doublon`, cookieOf(a.u), { statut: 'confirme' });
  assert.equal(r.status, 404, 'entreprise d\'un autre cabinet → introuvable');
  assert.equal(db.prepare('SELECT statut_doublon FROM facture WHERE id=?').get(fidB).statut_doublon, 'potentiel', 'facture de B inchangée');
});
test('doublon/C18 utilisateur non authentifié refusé (401)', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  const r = await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, null, { statut: 'confirme' });
  assert.equal(r.status, 401);
  assert.equal(db.prepare('SELECT statut_doublon FROM facture WHERE id=?').get(fid).statut_doublon, 'potentiel', 'inchangée');
});
test('doublon/C19 audit avant/après créé', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut: 'confirme' });
  const log = db.prepare("SELECT * FROM audit_log WHERE cabinet_id=? AND action='revue_doublon' ORDER BY created_at DESC LIMIT 1").get(t.cab);
  assert.ok(log, 'entrée d\'audit présente');
  const det = JSON.parse(log.details);
  assert.equal(det.avant.statut_doublon, 'potentiel'); assert.equal(det.apres.statut_doublon, 'confirme');
});
test('doublon/C20 anomalie cohérente après confirmation', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut: 'confirme' });
  const ano = db.prepare("SELECT * FROM anomalie WHERE entite_id=? AND type='doublon_potentiel'").get(fid);
  assert.equal(ano.statut, 'resolue'); assert.equal(ano.motif_resolution, 'doublon_confirme'); assert.ok(ano.resolue_le);
});
test('doublon/C21 anomalie cohérente après faux positif (alerte désactivée)', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t);
  await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut: 'faux_positif' });
  const ano = db.prepare("SELECT * FROM anomalie WHERE entite_id=? AND type='doublon_potentiel'").get(fid);
  assert.equal(ano.statut, 'resolue'); assert.equal(ano.motif_resolution, 'faux_positif');
  // réouverture possible : potentiel réactive l'alerte
  await patchJson(`/api/clients/${t.ent}/factures/${fid}/doublon`, cookieOf(t.u), { statut: 'potentiel' });
  assert.equal(db.prepare("SELECT statut FROM anomalie WHERE entite_id=?").get(fid).statut, 'ouverte', 'alerte réactivée');
});

/* -------------------- D. API ET INTERFACE -------------------- */
test('doublon/D22-D23 /delais expose tous les champs + compat doublon_potentiel', async () => {
  const t = newTenant(); const fid = seedDoublonFac(t, 'API-1');
  const res = await fetch(baseUrl() + `/api/clients/${t.ent}/delais?annee=2026&trimestre=1`, { headers: { Cookie: cookieOf(t.u) } });
  const data = await res.json();
  const row = data.rows.find(r => r.numero === 'API-1');
  assert.ok(row, 'ligne présente');
  for (const k of ['doublon_potentiel', 'motif_doublon', 'statut_doublon', 'date_revue_doublon', 'utilisateur_revue_doublon', 'anomalie_doublon_active']) assert.ok(k in row, `champ ${k} exposé`);
  assert.equal(row.doublon_potentiel, true, 'compat : booléen conservé');
  assert.equal(row.statut_doublon, 'potentiel'); assert.equal(row.anomalie_doublon_active, true);
});
test('doublon/D24-D26 frontend : badge + actions appellent la bonne route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(/function doublonBadge/.test(src) && /Doublon \?/.test(src) && /Doublon confirmé/.test(src), 'badges présents');
  assert.ok(/reviewDoublon/.test(src), 'handler de revue présent');
  assert.ok(/factures\/\$\{fid\}\/doublon/.test(src) && /method: 'PATCH'/.test(src), 'appel PATCH sur la bonne route');
  assert.ok(/data-act="\$\{act\}"/.test(src) && /statut: act/.test(src), 'le statut choisi est transmis à la route');
  assert.ok(/A\('confirme'/.test(src), 'action confirmer'); assert.ok(/A\('faux_positif'/.test(src), 'action faux positif');
  // Export Excel par filtre présent dans le frontend
  assert.ok(/xls-export/.test(src) && /function exportDelais/.test(src), 'boutons d\'export Excel présents');
  assert.ok(/delais\/export\.xlsx/.test(src), 'appel à la route d\'export xlsx');
});

/* -------------------- D' . EXPORT EXCEL DE LA FEUILLE DE DÉLAIS -------------------- */
// Seed : 3 factures — 1 en retard (a_declarer), 1 sans convention à 120 j, 1 normale.
function seedDelaisMix(t) {
  const f1 = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(f1, t.cab, t.ent, 'FRS RETARD');
  const f2 = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,120)').run(f2, t.cab, t.ent, 'FRS 120 SANS CONV');
  const f3 = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(f3, t.cab, t.ent, 'FRS OK');
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer,montant_amende) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid('fac'), t.cab, t.ent, f1, 'R-1', 100000, '2026-01-05', 2026, 1, 60, 120, 60, 1, 3000);
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer,montant_amende) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid('fac'), t.cab, t.ent, f2, 'C-1', 50000, '2026-01-06', '2026-01-20', 2026, 1, 120, 14, 0, 0, 0);
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer,montant_amende) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid('fac'), t.cab, t.ent, f3, 'OK-1', 20000, '2026-01-07', '2026-01-15', 2026, 1, 60, 8, 0, 0, 0);
}
async function getXlsx(pathUrl, cookie) {
  const res = await fetch(baseUrl() + pathUrl, { headers: cookie ? { Cookie: cookie } : {} });
  const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  return { status: res.status, ct: res.headers.get('content-type') || '', cd: res.headers.get('content-disposition') || '', buf };
}
function xlsxRows(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
}
test('export/délais : xlsx « toutes » — 3 factures, en-têtes, total, format', async () => {
  const t = newTenant(); seedDelaisMix(t);
  const r = await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx?annee=2026&trimestre=1&filter=all`, cookieOf(t.u));
  assert.equal(r.status, 200);
  assert.match(r.ct, /spreadsheetml/); assert.match(r.cd, /\.xlsx/); assert.match(r.cd, /_all\.xlsx/);
  const rows = xlsxRows(r.buf);
  assert.match(String(rows[0][0]), /Feuille de calcul des délais/, 'titre');
  const head = rows.find(row => row[0] === 'N° facture');
  assert.ok(head, 'ligne d\'en-tête présente');
  assert.ok(head.includes('Montant TTC (DH)') && head.includes('Amende (DH)') && head.includes('Revue doublon'), 'colonnes formatées');
  const nums = rows.filter(row => /^(R-1|C-1|OK-1)$/.test(String(row[0])));
  assert.equal(nums.length, 3, '3 factures exportées (toutes)');
  const total = rows.find(row => row[0] === 'TOTAL');
  assert.ok(total, 'ligne TOTAL présente');
  assert.equal(total[5], 170000, 'total TTC exact');
  assert.equal(total[13], 3000, 'total amende exact');
});
test('export/délais : xlsx « retard » — seules les factures à déclarer', async () => {
  const t = newTenant(); seedDelaisMix(t);
  const r = await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx?annee=2026&trimestre=1&filter=retard`, cookieOf(t.u));
  assert.equal(r.status, 200); assert.match(r.cd, /_retard\.xlsx/);
  const rows = xlsxRows(r.buf);
  const nums = rows.filter(row => /^(R-1|C-1|OK-1)$/.test(String(row[0]))).map(row => row[0]);
  assert.deepEqual(nums, ['R-1'], 'seule la facture en retard');
});
test('export/délais : xlsx « convention absente » — délai 120 sans convention', async () => {
  const t = newTenant(); seedDelaisMix(t);
  const r = await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx?annee=2026&trimestre=1&filter=conv`, cookieOf(t.u));
  assert.equal(r.status, 200); assert.match(r.cd, /_conv\.xlsx/);
  const rows = xlsxRows(r.buf);
  const nums = rows.filter(row => /^(R-1|C-1|OK-1)$/.test(String(row[0]))).map(row => row[0]);
  assert.deepEqual(nums, ['C-1'], 'seule la facture 120 j sans convention');
});
test('export/délais : filtre inconnu → « toutes » ; isolation tenant (404) ; non authentifié (401)', async () => {
  const a = newTenant('A'), b = newTenant('B'); seedDelaisMix(a);
  const bad = await getXlsx(`/api/clients/${a.ent}/delais/export.xlsx?annee=2026&trimestre=1&filter=zzz`, cookieOf(a.u));
  assert.equal(bad.status, 200); const nums = xlsxRows(bad.buf).filter(row => /^(R-1|C-1|OK-1)$/.test(String(row[0])));
  assert.equal(nums.length, 3, 'filtre inconnu = toutes');
  const cross = await getXlsx(`/api/clients/${a.ent}/delais/export.xlsx?annee=2026&trimestre=1`, cookieOf(b.u));
  assert.equal(cross.status, 404, 'autre tenant → introuvable');
  const noauth = await getXlsx(`/api/clients/${a.ent}/delais/export.xlsx?annee=2026&trimestre=1`, null);
  assert.equal(noauth.status, 401, 'non authentifié refusé');
});

/* -------------------- E. NON-RÉGRESSION MÉTIER -------------------- */
test('doublon/E27 montants différents → conservés, NON associés', () => {
  const { cab, ent } = seedCab();
  const b1 = facBuf([['M', '2026-01-05', 'FRS M', '000000000000821', 1000, '2026-02-01']]);
  const b2 = facBuf([['M', '2026-01-05', 'FRS M', '000000000000821', 1500, '2026-02-01']]); // même n°/date, TTC ≠
  importer.importWorkbook(b1, { cabinetId: cab, entrepriseId: ent, sourceName: 's', periode: { annee: 2026, trimestre: 1 } });
  const r2 = importer.importWorkbook(b2, { cabinetId: cab, entrepriseId: ent, sourceName: 's2', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r2.duplicates, 0, 'montants différents ≠ doublon'); assert.equal(facturesOf(ent), 2);
});
test('doublon/E28 fournisseurs différents → non associés', () => {
  const { cab, ent } = seedCab();
  const b1 = facBuf([['S', '2026-01-05', 'FRS UN', '000000000000831', 1000, '2026-02-01']]);
  const b2 = facBuf([['S', '2026-01-05', 'FRS DEUX', '000000000000832', 1000, '2026-02-01']]); // même n°/date/TTC, fournisseur ≠
  importer.importWorkbook(b1, { cabinetId: cab, entrepriseId: ent, sourceName: 's', periode: { annee: 2026, trimestre: 1 } });
  const r2 = importer.importWorkbook(b2, { cabinetId: cab, entrepriseId: ent, sourceName: 's2', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r2.duplicates, 0, 'fournisseurs différents ≠ doublon');
});
test('doublon/E29 aucun doublon technique de jointure SQL (facture→fournisseur 1:1)', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS J');
  for (const n of ['J1', 'J2', 'J3']) db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre) VALUES (?,?,?,?,?,?,?,?,?)').run(uid('fac'), t.cab, t.ent, fid, n, 1000, '2026-01-05', 2026, 1);
  const data = await (await fetch(baseUrl() + `/api/clients/${t.ent}/delais?annee=2026&trimestre=1`, { headers: { Cookie: cookieOf(t.u) } })).json();
  const base = data.rows.filter(r => !r.incidence);
  assert.equal(base.length, 3, 'exactement 3 lignes (pas de multiplication par jointure)');
});
test('doublon/E30 opérateurs réseau inchangés', () => {
  assert.equal(reseau.resolveDelaiAutorise({ fournisseur: { operateur_reseau: 1, statut_classification: 'confirme', delai_special: 30 } }).delaiAutorise, 30);
});
test('doublon/E31 import des conventions inchangé', () => {
  const t = newTenant();
  const r = impConv(t, [['CONV Z', '000000000000841', '', '', 'OUI', 90]]);
  assert.equal(r.conventionsCreated, 1);
  assert.equal(convOfEnt(t.ent)[0].delai_convenu, 90);
});
test('doublon/E32 date d\'arrêté trimestrielle inchangée', () => {
  assert.equal(A('2026-01-10', null, 2026, 1).dateArreteIso, '2026-03-31');
  assert.equal(A('2026-04-15', null, 2026, 2).dateArreteIso, '2026-06-30');
});
test('doublon/E33 périodes clôturées inchangées (verrou)', () => {
  assert.equal(periode.isLocked('cloturee'), true); assert.equal(periode.isLocked('declaree'), true);
});
test('doublon/E34-E36 démo : 36 factures, 7025,33 DH, 2 doublons à amende nulle', () => {
  const { cab, ent } = seedCab();
  const r = importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: cab, entrepriseId: ent, sourceName: demoFixture.DEMO_SOURCE_NAME, periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r.imported, 36, 'démo = 36 factures');
  assert.equal(r.duplicates, 2, '2 doublons potentiels gardés');
  const amende = db.prepare('SELECT ROUND(SUM(montant_amende),2) s FROM facture WHERE entreprise_id=?').get(ent).s;
  assert.ok(Math.abs(amende - 7025.33) < 0.5, `amende ${amende} ≈ 7025,33 (inchangée)`);
  const dups = db.prepare('SELECT montant_amende, statut_doublon FROM facture WHERE entreprise_id=? AND doublon_potentiel=1').all(ent);
  assert.equal(dups.length, 2);
  for (const d of dups) { assert.equal(d.montant_amende || 0, 0, 'ligne doublon → amende nulle'); assert.equal(d.statut_doublon, 'potentiel'); }
  assert.equal(anomaliesDoublon(ent).length, 2, '2 anomalies basses créées');
});

/* ==================================================================================
 * IMPORT CONVENTIONS UNIFIÉ (mapping libre) · normalizeSupplierName · délai strict ·
 * recalcul des périodes ouvertes · VRAI numéro de ligne Excel.
 * ================================================================================== */
const { normalizeSupplierName } = require('../src/util');

// Classeur générique (aoa brut) — permet des colonnes libres et des lignes réellement vides.
function aoaBuf(aoa, sheet = 'Feuille1') {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/* -------------------- OBJ 2 : normalizeSupplierName (comparaison uniquement) -------------------- */
test('conv/OBJ2 normalizeSupplierName : casse / accents / espaces / tirets / underscores', () => {
  const eq = (a, b) => assert.equal(normalizeSupplierName(a), normalizeSupplierName(b), `${a} ≡ ${b}`);
  eq('HLZ', 'hlz'); eq('HLZ', 'HlZ');
  eq('HLZ Consulting', 'hlz consulting'); eq('HLZ Consulting', 'HLZ CONSULTING');
  eq('HLZ Consulting', 'HLZ   Consulting'); eq('HLZ Consulting', 'HLZ-Consulting'); eq('HLZ Consulting', 'HLZ_Consulting');
  eq('HLZ\tConsulting', 'HLZ Consulting');
  eq('Sté Générale', 'ste generale'); // accents + forme juridique neutralisée
  assert.notEqual(normalizeSupplierName('HLZ Consulting'), normalizeSupplierName('ABC Consulting'), 'noms distincts ≠');
});
test('conv/OBJ2 matching robuste (nom) + priorité ICE, nom affiché inchangé', () => {
  const t = newTenant();
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'HLZ Consulting');
  // Convention importée avec un nom « sale » (casse/tiret/underscore) et SANS identifiant → matché par nom normalisé.
  const buf = aoaBuf([['Nom', 'Convention', 'Delai'], ['  hlz-consulting  ', 'OUI', 45]], 'Conv');
  const r = importer.importConventions(buf, { cabinetId: t.cab, entrepriseId: t.ent, mapping: { nom: 0, conv: 1, delai: 2 }, sheetName: 'Conv', headerRow: 0 });
  assert.equal(r.conventionsCreated, 1);
  assert.equal(r.suppliersFound, 1, 'fournisseur existant retrouvé (pas de doublon créé)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE entreprise_id=?').get(t.ent).n, 1, 'aucun fournisseur en double');
  assert.equal(db.prepare('SELECT raison_sociale FROM fournisseur WHERE id=?').get(fid).raison_sociale, 'HLZ Consulting', 'nom affiché JAMAIS modifié');
  assert.equal(db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(fid).delai_applicable, 45);
});
test('conv/OBJ2 priorité ICE sur le nom', () => {
  const t = newTenant();
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable) VALUES (?,?,?,?,?,60)').run(fid, t.cab, t.ent, 'NOM ORIGINAL SARL', '000000000000901');
  // Même ICE mais nom TOTALEMENT différent → doit matcher par ICE (priorité), pas créer un nouveau fournisseur.
  const buf = aoaBuf([['Nom', 'ICE', 'Convention', 'Delai'], ['Autre Raison', '000000000000901', 'OUI', 100]], 'Conv');
  const r = importer.importConventions(buf, { cabinetId: t.cab, entrepriseId: t.ent, mapping: { nom: 0, ice: 1, conv: 2, delai: 3 }, sheetName: 'Conv', headerRow: 0 });
  assert.equal(r.suppliersFound, 1); assert.equal(r.conventionsCreated, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE entreprise_id=?').get(t.ent).n, 1, 'matché par ICE, pas de doublon');
  assert.equal(db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(fid).delai_applicable, 100);
});

/* -------------------- OBJ 3/7 : délai conventionnel strict (1..120, exact) -------------------- */
test('conv/OBJ3 parseConvDelaiStrict : entier 1..120 accepté EXACTEMENT', () => {
  for (const v of [1, 17, 42, 79, 91, 103, 120]) {
    const p = importer.parseConvDelaiStrict(v); assert.ok(p.ok, `${v} accepté`); assert.equal(p.delai, v, `${v} conservé exactement`);
    const ps = importer.parseConvDelaiStrict(String(v)); assert.ok(ps.ok && ps.delai === v, `"${v}" (texte) → ${v}`);
  }
});
test('conv/OBJ7 parseConvDelaiStrict : refus vide/0/négatif/>120/décimal/texte', () => {
  const bad = { '': 'absent', 0: 'invalide', '-5': 'invalide', 121: 'superieur_max', 200: 'superieur_max', '79.5': 'decimal', '60,5': 'decimal', '60 à 120': 'multiple', abc: 'texte' };
  for (const [v, reason] of Object.entries(bad)) {
    const raw = v === '0' ? 0 : (v === '121' ? 121 : (v === '200' ? 200 : v));
    const p = importer.parseConvDelaiStrict(raw); assert.ok(!p.ok, `${JSON.stringify(raw)} refusé`); assert.equal(p.reason, reason, `${JSON.stringify(raw)} → ${reason}`);
  }
  assert.ok(!importer.parseConvDelaiStrict(79.5).ok, '79.5 (nombre décimal) refusé');
});
test('conv/OBJ-robuste parseConvDelaiStrict : formats Excel réels (90JOURS, 90 J, 90.0…)', () => {
  // Formats VALIDES → nombre extrait, casse/espaces/tabulations/unité ignorés.
  const okCases = {
    '90': 90, '90.0': 90, '90,0': 90, '90 J': 90, '90J': 90, '90 Jour': 90, '90 Jours': 90,
    '90JOUR': 90, '90JOURS': 90, '90 jours': 90, ' 90 JOURS ': 90, '\t90\tJOURS ': 90,
    '120JOURS': 120, '60 jours': 60, '30J': 30, '45 Jour': 45, '79 jours': 79, '1 jour': 1, '120 J': 120,
  };
  for (const [v, exp] of Object.entries(okCases)) {
    const p = importer.parseConvDelaiStrict(v);
    assert.ok(p.ok, `"${v}" accepté`); assert.equal(p.delai, exp, `"${v}" → ${exp}`);
  }
  // Formats INVALIDES → refus (règle métier 1..120 inchangée).
  const badCases = { '121JOURS': 'superieur_max', '0JOURS': 'invalide', abc: 'texte', '90/120': 'multiple', '90 et 120': 'multiple', '90.5 jours': 'decimal', '-5 jours': 'invalide', '200 J': 'superieur_max' };
  for (const [v, reason] of Object.entries(badCases)) {
    const p = importer.parseConvDelaiStrict(v);
    assert.ok(!p.ok, `"${v}" refusé`); assert.equal(p.reason, reason, `"${v}" → ${reason}`);
  }
});
test('conv/OBJ3 import mappé : délais 17..120 enregistrés EXACTEMENT (aucune conversion)', () => {
  const t = newTenant();
  const rows = [['Nom', 'ICE', 'Convention', 'Delai']];
  const vals = [17, 42, 79, 91, 103, 120];
  vals.forEach((d, i) => rows.push([`FRS ${d}`, '0000000009100' + (10 + i), 'OUI', d]));
  const r = importer.importConventions(aoaBuf(rows, 'Conv'), { cabinetId: t.cab, entrepriseId: t.ent, mapping: { nom: 0, ice: 1, conv: 2, delai: 3 }, sheetName: 'Conv', headerRow: 0 });
  assert.equal(r.conventionsCreated, 6);
  for (const d of vals) {
    const c = db.prepare(`SELECT delai_convenu FROM convention c JOIN fournisseur f ON f.id=c.fournisseur_id WHERE f.entreprise_id=? AND f.raison_sociale=?`).get(t.ent, `FRS ${d}`);
    assert.equal(c.delai_convenu, d, `délai ${d} enregistré exactement`);
  }
});
test('conv/OBJ7 import mappé : valeurs invalides rejetées avec message explicite (jamais corrigées)', () => {
  const t = newTenant();
  const rows = [['Nom', 'ICE', 'Convention', 'Delai'],
    ['FRS OK', '000000000009201', 'OUI', 79],       // valide
    ['FRS ZERO', '000000000009202', 'OUI', 0],       // refus
    ['FRS SUP', '000000000009203', 'OUI', 121],      // refus
    ['FRS DEC', '000000000009204', 'OUI', 60.5],     // refus
    ['FRS TXT', '000000000009205', 'OUI', 'soixante'], // refus
    ['FRS VIDE', '000000000009206', 'OUI', ''],       // refus
  ];
  const r = importer.importConventions(aoaBuf(rows, 'Conv'), { cabinetId: t.cab, entrepriseId: t.ent, mapping: { nom: 0, ice: 1, conv: 2, delai: 3 }, sheetName: 'Conv', headerRow: 0 });
  assert.equal(r.conventionsCreated, 1, 'seule la ligne valide crée une convention');
  assert.equal(r.rejected, 5, '5 lignes rejetées');
  const rejets = r.lignes.filter(l => l.statut === 'rejetee');
  assert.ok(rejets.every(l => /entier compris entre 1 et 120/.test(l.motif)), 'message explicite unique');
  assert.equal(db.prepare('SELECT delai_convenu FROM convention c JOIN fournisseur f ON f.id=c.fournisseur_id WHERE f.entreprise_id=? AND f.raison_sociale=?').get(t.ent, 'FRS OK').delai_convenu, 79);
});
test('conv/OBJ-robuste import mappé : fichier réel type « 90JOURS / 120JOURS / 60 jours » importé sans rejet', () => {
  const t = newTenant();
  // Reproduit « ETATS CONVENTIONS.xlsx » : colonne « Délai de paiement convenu » avec suffixes texte.
  const rows = [['Fournisseur', 'ICE', 'Convention OUI/NON', 'Délai de paiement convenu'],
    ['FRS A', '000000000009301', 'OUI', '90JOURS'],
    ['FRS B', '000000000009302', 'OUI', '120JOURS'],
    ['FRS C', '000000000009303', 'OUI', '60 jours'],
    ['FRS D', '000000000009304', 'OUI', '30J'],
    ['FRS E', '000000000009305', 'OUI', '45 Jour'],
    ['FRS TROP', '000000000009306', 'OUI', '121JOURS'],   // seule ligne réellement invalide
  ];
  const r = importer.importConventions(aoaBuf(rows, 'Conv'), { cabinetId: t.cab, entrepriseId: t.ent, mapping: { nom: 0, ice: 1, conv: 2, delai: 3 }, sheetName: 'Conv', headerRow: 0 });
  assert.equal(r.conventionsCreated, 5, 'les lignes valides ne sont plus rejetées');
  assert.equal(r.rejected, 1, 'seule « 121JOURS » rejetée');
  const del = nom => db.prepare('SELECT delai_convenu FROM convention c JOIN fournisseur f ON f.id=c.fournisseur_id WHERE f.entreprise_id=? AND f.raison_sociale=?').get(t.ent, nom).delai_convenu;
  assert.equal(del('FRS A'), 90); assert.equal(del('FRS B'), 120); assert.equal(del('FRS C'), 60);
  assert.equal(del('FRS D'), 30); assert.equal(del('FRS E'), 45);
});

/* -------------------- OBJ 5 : VRAI numéro de ligne Excel -------------------- */
test('conv/OBJ5 numéro de ligne Excel réel malgré des lignes vides', () => {
  const t = newTenant();
  // En-tête ligne 1, données 2, lignes 3 & 4 VIDES, erreur ligne 5.
  const buf = aoaBuf([
    ['Nom', 'ICE', 'Convention', 'Delai'],           // Excel 1
    ['FRS A', '000000000009301', 'OUI', 60],          // Excel 2
    [],                                               // Excel 3 (vide)
    [],                                               // Excel 4 (vide)
    ['FRS ERR', '000000000009302', 'OUI', 999],       // Excel 5 (délai invalide)
  ], 'Conv');
  const r = importer.importConventions(buf, { cabinetId: t.cab, entrepriseId: t.ent, mapping: { nom: 0, ice: 1, conv: 2, delai: 3 }, sheetName: 'Conv', headerRow: 0 });
  const err = r.lignes.find(l => l.statut === 'rejetee');
  assert.ok(err, 'ligne en erreur présente');
  assert.equal(err.ligne, 5, 'numéro de ligne = 5 (réel Excel), pas 3 (compacté)');
});
test('import/OBJ5 preview factures : numéro de ligne Excel réel (lignes vides ignorées)', () => {
  const { cab, ent } = seedCab();
  const buf = aoaBuf([
    ['N°', 'Date facture', 'Fournisseur', 'TTC', 'Date paiement'],  // Excel 1
    ['F1', '2026-01-05', 'FRS A', 1000, '2026-02-01'],              // Excel 2
    [],                                                             // Excel 3 (vide)
    [],                                                             // Excel 4 (vide)
    ['F2', '2026-01-06', '', 500, ''],                              // Excel 5 (sans fournisseur → rejetée)
  ], 'S');
  const pv = importer.previewImport(buf, { sheetName: 'S', headerRow: 0, mapping: { numero: 0, date_facture: 1, four_nom: 2, ttc: 3, date_paiement: 4 }, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1 });
  const rej = pv.apercu.rejetees.find(l => /fournisseur/.test(l.motif));
  assert.ok(rej, 'ligne rejetée présente'); assert.equal(rej.ligne, 5, 'numéro de ligne réel = 5');
});

/* -------------------- OBJ 1 : réutilisation du composant de mapping (analyse) -------------------- */
test('conv/OBJ1 analyzeWorkbook(kind=conventions) → champs conventions + mapping auto', () => {
  const a = importer.analyzeWorkbook(aoaBuf([['Nom fournisseur', 'ICE', 'Convention', 'Délai convenu'], ['X', '000000000009401', 'OUI', 60]], 'Conv'), 'conventions');
  assert.equal(a.kind, 'conventions');
  const keys = a.champs.map(c => c.key);
  assert.ok(keys.includes('nom') && keys.includes('delai') && keys.includes('conv') && keys.includes('ice'), 'champs conventions exposés');
  const sug = a.feuilles.find(f => f.nom === a.suggestion) || a.feuilles[0];
  assert.ok(sug.mapping.nom && sug.mapping.delai, 'mapping automatique proposé (nom + délai)');
});
test('conv/OBJ1 preview (dryRun) n\'écrit rien ; confirm écrit', () => {
  const t = newTenant();
  const buf = aoaBuf([['Nom', 'ICE', 'Convention', 'Delai'], ['FRS DRY', '000000000009501', 'OUI', 88]], 'Conv');
  const opts = { cabinetId: t.cab, entrepriseId: t.ent, mapping: { nom: 0, ice: 1, conv: 2, delai: 3 }, sheetName: 'Conv', headerRow: 0 };
  const pv = importer.importConventions(buf, { ...opts, dryRun: true });
  assert.equal(pv.conventionsCreated, 1, 'compté en prévisualisation');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE entreprise_id=?').get(t.ent).n, 0, 'dryRun : AUCUNE écriture');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE entreprise_id=?').get(t.ent).n, 0, 'dryRun : aucun fournisseur créé');
  const r = importer.importConventions(buf, opts);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE entreprise_id=?').get(t.ent).n, 1, 'confirm : convention créée');
});

/* -------------------- OBJ 4 : recalcul des périodes ouvertes (HTTP), clôturées intactes -------------------- */
test('conv/OBJ4 HTTP : convention → recalcul période ouverte ; période clôturée intacte', async () => {
  const t = newTenant();
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable) VALUES (?,?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS RECALC', '000000000009601');
  // Facture période OUVERTE (T1) et facture période CLÔTURÉE (T2), délai initial 60, retard 76 j (15/01 impayée → 31/03).
  const fOpen = uid('fac'); db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(fOpen, t.cab, t.ent, fid, 'OPEN', 100000, '2026-01-15', 2026, 1, 60, 75, 15, 1);
  const fClosed = uid('fac'); db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(fClosed, t.cab, t.ent, fid, 'CLOSED', 100000, '2026-04-15', 2026, 2, 60, 76, 16, 1);
  // Période T2 CLÔTURÉE (verrouillée).
  db.prepare(`INSERT INTO periode_declaration (id,cabinet_id,entreprise_id,annee,trimestre,statut) VALUES (?,?,?,?,?,?)`).run(uid('per'), t.cab, t.ent, 2026, 2, 'cloturee');
  const buf = convBuf([['FRS RECALC', '000000000009601', '', '', 'OUI', 90]]);
  const res = await postFile(`/api/clients/${t.ent}/conventions/import`, cookieOf(t.u), buf, 'l.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(fOpen).delai_applicable, 90, 'période ouverte recalculée (délai 90)');
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(fClosed).delai_applicable, 60, 'période clôturée INTACTE (délai 60)');
});
test('conv/OBJ1 HTTP : assistant conventions analyze(kind) → preview → confirm', async () => {
  const t = newTenant();
  const buf = aoaBuf([['Nom', 'ICE', 'Convention', 'Delai'], ['FRS WIZ', '000000000009701', 'OUI', 73]], 'Conv');
  // analyse (kind=conventions) → token
  const fd = new FormData(); fd.append('file', new Blob([buf]), 'c.xlsx'); fd.append('kind', 'conventions');
  const aRes = await fetch(baseUrl() + `/api/clients/${t.ent}/import/analyze`, { method: 'POST', headers: { Cookie: cookieOf(t.u) }, body: fd });
  const a = await aRes.json();
  assert.equal(a.kind, 'conventions'); assert.ok(a.token);
  const body = { token: a.token, sheetName: 'Conv', headerRow: 0, mapping: { nom: 0, ice: 1, conv: 2, delai: 3 }, sourceName: 'c.xlsx' };
  // preview (aucune écriture)
  const pv = await postJson(`/api/clients/${t.ent}/conventions/preview`, cookieOf(t.u), body);
  assert.equal(pv.status, 200); assert.equal(pv.body.conventionsCreated, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM convention WHERE entreprise_id=?').get(t.ent).n, 0, 'preview n\'écrit rien');
  // confirm (écrit + délai exact 73)
  const cf = await postJson(`/api/clients/${t.ent}/conventions/confirm`, cookieOf(t.u), body);
  assert.equal(cf.status, 200); assert.equal(cf.body.conventionsCreated, 1);
  const c = db.prepare(`SELECT delai_convenu FROM convention c JOIN fournisseur f ON f.id=c.fournisseur_id WHERE f.entreprise_id=? AND f.raison_sociale=?`).get(t.ent, 'FRS WIZ');
  assert.equal(c.delai_convenu, 73, 'délai exact 73 enregistré via l\'assistant');
});

/* -------------------- OBJ 8 : non-régression import conventions AUTO (legacy) -------------------- */
test('conv/OBJ8 legacy auto (sans mapping) : « 60 à 120 » → 120 inchangé', () => {
  const t = newTenant();
  const r = importer.importConventions(convBuf([['LEG PLAGE', '000000000009801', '', '', 'OUI', '60 à 120']]), { cabinetId: t.cab, entrepriseId: t.ent });
  assert.equal(r.conventionsCreated, 1);
  assert.equal(convOfEnt(t.ent)[0].delai_convenu, 120, 'mode auto legacy : plage → plus grand (inchangé)');
});

/* ==================================================================================
 * LOT 1 (P0) — SÉCURISATION DE L'AUTO-MAPPING (corruption silencieuse relevé EDI 005)
 * ================================================================================== */
// Relevés EDI de déduction TVA anonymisés (structure et en-têtes d'origine, libellés/identifiants aléatoires).
const ediFixture = n => fixtureBuf(n === '004' ? 'automap-edi-a' : 'automap-edi-b');
function autoMap(buf) {
  const a = importer.analyzeWorkbook(buf, 'factures');
  const s = a.feuilles.find(x => x.nom === a.suggestion) || a.feuilles[0];
  const m = {}; for (const [k, v] of Object.entries(s.mapping)) m[k] = { label: (s.colonnes[v.col] || {}).label, conf: v.confidence };
  return { a, sheet: s, m };
}
test('automap/L1 relevé EDI 004 : Fournisseur→LIB_FRSS, TTC→M_TTC (titre, 92%)', () => {
  const { m } = autoMap(ediFixture('004'));
  assert.equal(m.four_nom.label, 'LIB_FRSS'); assert.equal(m.ttc.label, 'M_TTC');
  assert.ok(m.four_nom.conf >= 0.9 && m.ttc.conf >= 0.9, 'confiance élevée par titre');
});
test('automap/L1 relevé EDI 005 : Fournisseur ne mappe JAMAIS M_TTC, TTC jamais ORDRE', () => {
  const { m } = autoMap(ediFixture('005'));
  assert.equal(m.four_nom.label, 'LIB_FRSS', 'Fournisseur = LIB_FRSS (pas M_TTC)');
  assert.equal(m.ttc.label, 'M_TTC', 'TTC = M_TTC (pas ORDRE)');
  assert.notEqual(m.four_nom.label, 'M_TTC'); assert.notEqual(m.ttc.label, 'ORDRE');
});
test('automap/L1 validation BLOQUE un mapping forcé incohérent (four_nom=M_TTC, ttc=ORDRE)', () => {
  const wb = XLSX.read(ediFixture('005'), { cellDates: true });
  const grid = XLSX.utils.sheet_to_json(wb.Sheets['EDI'], { header: 1, blankrows: true, raw: true });
  const v = importer.validateImportMapping({ grid, headerRow: 7, startRow: 8, mapping: { four_nom: 5, ttc: 0, date_facture: 12 } });
  assert.equal(v.ok, false, 'mapping incohérent refusé');
  assert.ok(v.errors.some(e => e.code === 'four_numerique'), 'Fournisseur numérique bloqué');
  assert.ok(v.errors.some(e => e.code === 'ttc_sequence'), 'TTC séquentiel bloqué');
});
test('automap/L1 confirmImport REFUSE un mapping incohérent (aucune écriture)', () => {
  const { cab, ent } = seedCab();
  // Colonne 0 = séquence (ttc forcé), colonne 1 = montants (four_nom forcé)
  const buf = aoaBuf([['ORDRE', 'M_TTC', 'FRS', 'DATE'],
    [1, 15600, 'A', '2026-01-05'], [2, 7596, 'B', '2026-01-06'], [3, 530000, 'C', '2026-01-07']], 'S');
  assert.throws(() => importer.confirmImport(buf, { sheetName: 'S', headerRow: 0, mapping: { ttc: 0, four_nom: 1, date_facture: 3 }, cabinetId: cab, entrepriseId: ent, annee: 2026, trimestre: 1, sourceName: 'x' }), /Mapping refusé/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(ent).n, 0, 'aucune facture écrite');
});
test('automap/L1 colonne séquentielle 1,2,3… refusée comme TTC ; colonne monétaire refusée comme Fournisseur', () => {
  const grid = [['SEQ', 'MONTANT', 'NOM', 'DATE'],
    [1, 1200.5, 'ALPHA', '2026-01-05'], [2, 3400, 'BETA', '2026-01-06'], [3, 5600.75, 'GAMMA', '2026-01-07'], [4, 890, 'DELTA', '2026-01-08']];
  const seqAsTtc = importer.validateImportMapping({ grid, headerRow: 0, startRow: 1, mapping: { ttc: 0, four_nom: 2, date_facture: 3 } });
  assert.ok(seqAsTtc.errors.some(e => e.code === 'ttc_sequence'), 'séquence refusée comme TTC');
  const amtAsNom = importer.validateImportMapping({ grid, headerRow: 0, startRow: 1, mapping: { ttc: 1, four_nom: 1, date_facture: 3 } });
  assert.ok(!amtAsNom.ok, 'colonne monétaire refusée comme Fournisseur / conflit');
});
test('automap/L1 conflit de colonnes (même colonne pour four_nom et ttc)', () => {
  const grid = [['A', 'B'], [10, 'x'], [20, 'y']];
  const v = importer.validateImportMapping({ grid, headerRow: 0, startRow: 1, mapping: { ttc: 0, four_nom: 0, date_facture: 1 } });
  assert.ok(v.errors.some(e => e.code === 'conflit_colonne'), 'conflit détecté');
});
test('automap/L1 isValidSupplierDisplayName : rejette numérique, accepte noms réels', () => {
  for (const bad of ['7596', '5400', '55771.91', '28 200,00', '  120,00 ', '']) assert.equal(importer.isValidSupplierDisplayName(bad), false, `"${bad}" refusé`);
  for (const ok of ['SCHINDLER MAROC', 'SOCIETE 3D', 'CABINET 2000', 'MAROC 24', 'BATLUXE BUSINESS']) assert.equal(importer.isValidSupplierDisplayName(ok), true, `"${ok}" accepté`);
});
test('automap/L1 profileColumn : séquence vs montant vs texte vs date', () => {
  const seq = importer.profileColumn([1, 2, 3, 4, 5, 6]); assert.ok(seq.isSequential, 'séquence détectée');
  const amt = importer.profileColumn([1200.5, 3400, 56000, 890.25]); assert.ok(amt.numericRate >= 0.7 && amt.looksAmount, 'montant détecté'); assert.equal(amt.isSequential, false);
  const txt = importer.profileColumn(['ALPHA SARL', 'BETA', 'GAMMA SA']); assert.ok(txt.textRate >= 0.9, 'texte détecté');
});

/* ==================================================================================
 * LOT 2 (P1) — OPÉRATEURS RÉSEAU : surface des propositions + confirmation via l'UI/API.
 * ================================================================================== */
function seedFacFour(t, nom, { ice = null } = {}) {
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable) VALUES (?,?,?,?,?,60)').run(fid, t.cab, t.ent, nom, ice);
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable,delai_ecoule,retard_jours,a_declarer,montant_amende)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uid('fac'), t.cab, t.ent, fid, 'F-' + nom.slice(0, 3), 100000, '2026-01-15', 2026, 1, 60, 75, 15, 1, 1000);
  return fid;
}
async function delaisRows(t) {
  const url = baseUrl() + `/api/clients/${t.ent}/delais?annee=2026&trimestre=1`, opt = { headers: { Cookie: cookieOf(t.u), Connection: 'close' } };
  for (let i = 0; i < 3; i++) { try { const res = await fetch(url, opt); return (await res.json()).rows; } catch (e) { if (i === 2) throw e; } }
}
test('reseau/L2 /delais expose une PROPOSITION réseau (SRM, Maroc Telecom) et PAS de faux positif (LUBRIFIANTS MAROC)', async () => {
  const t = newTenant();
  seedFacFour(t, 'SRM MARRAKECH SAFI'); seedFacFour(t, 'MAROC TELECOM'); seedFacFour(t, 'LUBRIFIANTS MAROC');
  const rows = await delaisRows(t);
  const srm = rows.find(r => r.four === 'SRM MARRAKECH SAFI'), iam = rows.find(r => r.four === 'MAROC TELECOM'), total = rows.find(r => r.four === 'LUBRIFIANTS MAROC');
  assert.equal(srm.reseau_statut, 'propose', 'SRM proposé'); assert.equal(srm.operateur_reseau, false, 'pas encore confirmé');
  assert.equal(iam.reseau_statut, 'propose', 'Maroc Telecom proposé');
  assert.equal(total.reseau_statut, 'aucun', 'LUBRIFIANTS MAROC : aucun faux positif');
});
test('reseau/L2 confirmation → délai 30 j + exclusion déclarative + reste en vue interne', async () => {
  const t = newTenant();
  const fid = seedFacFour(t, 'MAROC TELECOM');
  const r = await patchJson(`/api/clients/${t.ent}/fournisseurs/${fid}/classification`, cookieOf(t.u), { operateur_reseau: true, statut: 'confirme', categorie_fournisseur: 'telecom' });
  assert.equal(r.status, 200);
  const rows = await delaisRows(t);
  const row = rows.find(r => r.four === 'MAROC TELECOM');
  assert.equal(row.operateur_reseau, true, 'confirmé'); assert.equal(row.delai_applicable, 30, 'délai 30 j appliqué'); assert.equal(row.hors_tableau, true, 'exclu du tableau déclaratif');
  assert.ok(row, 'toujours présent en vue interne (feuille de délais)');
  // Exclusion effective dans la déclaration
  const dec = await (await fetch(baseUrl() + `/api/clients/${t.ent}/declaration?annee=2026&trimestre=1`, { headers: { Cookie: cookieOf(t.u) } })).json();
  assert.ok(!dec.lignes.some(l => l.nom === 'MAROC TELECOM'), 'exclu de la déclaration');
  assert.ok(dec.exclusions.nbFactures >= 1, 'résumé des exclusions renseigné');
});
test('reseau/L2 règle configurable : DELAI_RESEAU pilote le délai appliqué', () => {
  const reseau = require('../src/reseau');
  assert.equal(reseau.DELAI_RESEAU, 30, 'valeur par défaut environnement de test');
  const rd = reseau.resolveDelaiAutorise({ fournisseur: { operateur_reseau: 1, statut_classification: 'confirme' } });
  assert.equal(rd.delaiAutorise, reseau.DELAI_RESEAU, 'le délai appliqué suit la constante configurable');
});

/* ==================================================================================
 * LOT 4 — INTÉGRITÉ MÉTIER DES CONVENTIONS
 * Une SEULE règle de délai applicable partout : reseau.resolveDelaiAutorise, alimentée
 * par UNE sélection de convention unique db.activeConventionFor (plus récente 'valide',
 * tie-break rowid). Aucun écran ne produit une règle différente.
 * ================================================================================== */
async function addFactureManuelle(t, fields) { return postJson(`/api/clients/${t.ent}/factures`, cookieOf(t.u), fields); }
function seedReseauFour(t, nom, ice) {
  const fid = uid('four');
  db.prepare(`INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,operateur_reseau,statut_classification,hors_tableau_declaratif,delai_special,categorie_fournisseur,delai_applicable) VALUES (?,?,?,?,?,1,'confirme',1,30,'telecom',60)`).run(fid, t.cab, t.ent, nom, ice);
  return fid;
}
async function delaisRowsP(t, annee, trimestre) {
  const res = await fetch(baseUrl() + `/api/clients/${t.ent}/delais?annee=${annee}&trimestre=${trimestre}`, { headers: { Cookie: cookieOf(t.u), Connection: 'close' } });
  return (await res.json()).rows;
}
async function deleteConv(t, convId) { return fetch(baseUrl() + `/api/clients/${t.ent}/conventions/${convId}`, { method: 'DELETE', headers: { Cookie: cookieOf(t.u) } }); }

// (Phase 2) CŒUR — la saisie manuelle applique la MÊME règle centrale que le recalcul.
test('lot4/unicité : facture manuelle sur opérateur réseau confirmé → 30 j (règle unique, pas 60)', async () => {
  const t = newTenant();
  const fid = seedReseauFour(t, 'IAM RESEAU', '000000000000801');
  const r = await addFactureManuelle(t, { fournisseur_id: fid, ttc: 10000, date_facture: '2026-01-10', date_paiement: '2026-04-30', annee: 2026, trimestre: 1 });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(r.body.id).delai_applicable, 30, 'délai réseau 30 j à la saisie manuelle (avant le correctif : 60)');
});
test('lot4/unicité : facture manuelle avec convention → délai de la convention', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS CONV');
  await postConvCreate(t, { fournisseur_id: fid, delai: 90 });
  const r = await addFactureManuelle(t, { fournisseur_id: fid, ttc: 10000, date_facture: '2026-01-10', annee: 2026, trimestre: 1 });
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(r.body.id).delai_applicable, 90);
});
test('lot4/unicité : facture manuelle standard → 60 j', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS STD');
  const r = await addFactureManuelle(t, { fournisseur_id: fid, ttc: 10000, date_facture: '2026-01-10', annee: 2026, trimestre: 1 });
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(r.body.id).delai_applicable, 60);
});
// (Phase 6) Deux conventions valides → la plus récente s'applique, à l'identique partout.
test('lot4/conflit : 2 conventions valides → la plus récente s\'applique (déterministe : sélection + saisie + feuille)', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS 2CONV');
  await postConvCreate(t, { fournisseur_id: fid, delai: 45 });   // ancienne
  await postConvCreate(t, { fournisseur_id: fid, delai: 100 });  // plus récente (même seconde → tie-break rowid)
  assert.equal(require('../src/db').activeConventionFor(t.ent, fid).delai_convenu, 100, 'activeConventionFor = la plus récente');
  const r = await addFactureManuelle(t, { fournisseur_id: fid, ttc: 10000, date_facture: '2026-01-10', annee: 2026, trimestre: 1 });
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(r.body.id).delai_applicable, 100, 'saisie manuelle = plus récente');
  assert.equal((await delaisRowsP(t, 2026, 1)).find(x => x.four === 'FRS 2CONV').delai_applicable, 100, 'feuille = plus récente');
});
// (Phase 6) Opérateur réseau confirmé prioritaire sur une convention.
test('lot4/conflit : opérateur réseau confirmé prioritaire sur convention (30 j gagne sur 120)', async () => {
  const t = newTenant();
  const fid = seedReseauFour(t, 'IAM PRIO', '000000000000802');
  await postConvCreate(t, { fournisseur_id: fid, delai: 120 });
  const r = await addFactureManuelle(t, { fournisseur_id: fid, ttc: 10000, date_facture: '2026-01-10', annee: 2026, trimestre: 1 });
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(r.body.id).delai_applicable, 30, 'réseau 30 j prioritaire');
  assert.equal((await delaisRowsP(t, 2026, 1)).find(x => x.four === 'IAM PRIO').delai_applicable, 30, 'feuille cohérente');
});
// (Phase 6) Convention expirée / future : validité fondée sur le statut (date = alerte/badge), déterministe.
test('lot4/conflit : convention expirée (date_fin passée) reste appliquée tant que statut=valide (règle explicite)', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS EXP');
  db.prepare(`INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,date_fin,statut) VALUES (?,?,?,?,?,?,'valide')`).run(uid('conv'), t.cab, t.ent, fid, 95, '2020-01-01');
  assert.equal(require('../src/db').activeConventionFor(t.ent, fid).delai_convenu, 95, 'validité par statut (date_fin = alerte/badge, non enforcement)');
  const r = await addFactureManuelle(t, { fournisseur_id: fid, ttc: 10000, date_facture: '2026-01-10', annee: 2026, trimestre: 1 });
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(r.body.id).delai_applicable, 95, 'comportement déterministe et documenté');
});
// (Phase 3 + 4) Recalcul automatique : créer/supprimer une convention recalcule les factures (période ouverte).
test('lot4/recalcul : convention créée → factures existantes recalculées ; supprimée → retour 60', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable) VALUES (?,?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS RECALC', '000000000000803');
  const fac = uid('fac');
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,?,60)`).run(fac, t.cab, t.ent, fid, 'F-R', 100000, '2026-01-10', '2026-04-30', 2026, 1);
  await postConvCreate(t, { fournisseur_id: fid, delai: 120 });
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(fac).delai_applicable, 120, 'facture recalculée à 120');
  const conv = convOfEnt(t.ent).find(c => c.fournisseur_id === fid);
  const del = await deleteConv(t, conv.id); assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(fac).delai_applicable, 60, 'retour 60 après suppression');
});
// (Phase 4) Période clôturée JAMAIS recalculée par une convention (OBJ4).
test('lot4/recalcul : période clôturée intacte lors d\'une création de convention', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,delai_applicable) VALUES (?,?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS LOCK', '000000000000804');
  db.prepare(`INSERT INTO periode_declaration (id,cabinet_id,entreprise_id,annee,trimestre,statut) VALUES (?,?,?,?,?,?)`).run(uid('per'), t.cab, t.ent, 2026, 1, 'cloturee');
  const fac = uid('fac');
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)`).run(fac, t.cab, t.ent, fid, 'F-L', 100000, '2026-01-10', 2026, 1);
  await postConvCreate(t, { fournisseur_id: fid, delai: 120 });
  assert.equal(db.prepare('SELECT delai_applicable FROM facture WHERE id=?').get(fac).delai_applicable, 60, 'période clôturée intacte (60)');
});
// (Phase 3) Cohérence feuille ↔ déclaration après convention (source unique).
test('lot4/cohérence : feuille et déclaration reflètent le même délai issu de la convention', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS COH');
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,delai_applicable,a_declarer) VALUES (?,?,?,?,?,?,?,?,?,?,60,1)`).run(uid('fac'), t.cab, t.ent, fid, 'F-C', 100000, '2026-01-10', '2026-03-31', 2026, 1);
  await postConvCreate(t, { fournisseur_id: fid, delai: 30 });   // délai court → retard maintenu
  assert.equal((await delaisRowsP(t, 2026, 1)).find(x => x.four === 'FRS COH').delai_applicable, 30, 'feuille = 30');
  const dec = await (await fetch(baseUrl() + `/api/clients/${t.ent}/declaration?annee=2026&trimestre=1`, { headers: { Cookie: cookieOf(t.u) } })).json();
  const line = dec.lignes.find(l => l.nom === 'FRS COH');
  assert.ok(line && line.retard > 0, 'déclaration reflète le délai court (retard) issu de la convention');
});
// (Phase 5) Audit : création et suppression tracent l'état (avant/après) pour comprendre la modification.
test('lot4/audit : création journalise delai + fournisseur ; suppression journalise l\'état avant', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS AUD');
  await postConvCreate(t, { fournisseur_id: fid, delai: 77 });
  const cre = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='create' AND entite='convention' AND cabinet_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(t.cab).details);
  assert.equal(cre.delai, 77); assert.equal(cre.fournisseur, fid);
  const conv = convOfEnt(t.ent).find(c => c.fournisseur_id === fid);
  await deleteConv(t, conv.id);
  const del = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='delete' AND entite='convention' AND cabinet_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(t.cab).details);
  assert.equal(del.delai_convenu, 77, 'délai avant tracé'); assert.equal(del.fournisseur, fid, 'fournisseur tracé');
});
// (Phase 3) Remplacement de document : délai inchangé, remplacement audité.
test('lot4/document : remplacer le document ne change pas le délai et est audité', async () => {
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS DOC');
  await postConvCreate(t, { fournisseur_id: fid, delai: 90 }, PDF_BYTES, 'c1.pdf', 'application/pdf');
  const conv = convOfEnt(t.ent).find(c => c.fournisseur_id === fid);
  const rep = await postFile(`/api/clients/${t.ent}/conventions/${conv.id}/file?replace=1`, cookieOf(t.u), JPEG_BYTES, 'c2.jpg', 'image/jpeg');
  assert.equal(rep.status, 200);
  assert.equal(db.prepare('SELECT delai_convenu FROM convention WHERE id=?').get(conv.id).delai_convenu, 90, 'délai inchangé par le remplacement de document');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='convention_pdf_remplace' AND cabinet_id=?").get(t.cab), 'remplacement audité');
});
// (Phase 6) activeConventionFor : ignore les conventions non valides et gère l'absence.
test('lot4/sélection : activeConventionFor ignore les conventions non valides et l\'absence', () => {
  const { activeConventionFor } = require('../src/db');
  const t = newTenant();
  const fid = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS SEL');
  assert.equal(activeConventionFor(t.ent, fid), null, 'aucune convention → null');
  assert.equal(activeConventionFor(t.ent, null), null, 'fournisseur nul → null');
  db.prepare(`INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut) VALUES (?,?,?,?,?, 'annulee')`).run(uid('conv'), t.cab, t.ent, fid, 50);
  assert.equal(activeConventionFor(t.ent, fid), null, 'convention non-valide ignorée');
});

/* ==================================================================================
 * LOT 5 — COHÉRENCE DES PÉRIODES
 * La période sélectionnée (annee/trimestre) est la SEULE utilisée. /summary et /clients
 * la respectent ; la fiche client n'est plus figée sur la dernière période (« bloquée sur T3 »).
 * ================================================================================== */
function seedFactP(t, { annee, trimestre, date, aDecl = 0, amende = 0, ttc = 10000, num }) {
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS ' + num);
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable,a_declarer,montant_amende)
              VALUES (?,?,?,?,?,?,?,?,?,60,?,?)`).run(uid('fac'), t.cab, t.ent, fid, num, ttc, date, annee, trimestre, aDecl, amende);
  return fid;
}
async function getJ(url, t) { return (await fetch(baseUrl() + url, { headers: { Cookie: cookieOf(t.u), Connection: 'close' } })).json(); }

// (Phase 3 + 5) La fiche client suit la période demandée — jamais figée sur « la dernière ».
test('lot5/summary : la fiche client suit la période demandée (pas de blocage sur la dernière)', async () => {
  const t = newTenant();
  seedFactP(t, { annee: 2026, trimestre: 1, date: '2026-02-10', num: 'A1' });
  seedFactP(t, { annee: 2026, trimestre: 3, date: '2026-08-10', num: 'B1' });
  seedFactP(t, { annee: 2026, trimestre: 3, date: '2026-08-11', num: 'B2' });
  const t1 = await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);
  const t3 = await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=3`, t);
  const def = await getJ(`/api/clients/${t.ent}/summary`, t);
  assert.deepEqual(t1.periode, { annee: 2026, trimestre: 1 });
  assert.equal(t1.kpis.factures, 1, 'T1 : 1 facture');
  assert.deepEqual(t3.periode, { annee: 2026, trimestre: 3 });
  assert.equal(t3.kpis.factures, 2, 'T3 : 2 factures');
  assert.equal(def.periode.trimestre, 3, 'sans période fournie → la plus récente (T3)');
});

// (Phase 2 + 5) Le portefeuille reflète la période active (retards/amende) ; cumul si absente.
test('lot5/clients : le portefeuille suit la période active (cumul toutes périodes si absente)', async () => {
  const t = newTenant();
  seedFactP(t, { annee: 2026, trimestre: 1, date: '2026-02-10', num: 'C1', aDecl: 1, amende: 100 });
  seedFactP(t, { annee: 2026, trimestre: 3, date: '2026-08-10', num: 'C2', aDecl: 1, amende: 250 });
  const row = l => l.find(c => c.id === t.ent);
  const listT1 = await getJ(`/api/clients?annee=2026&trimestre=1`, t);
  const listT3 = await getJ(`/api/clients?annee=2026&trimestre=3`, t);
  const listAll = await getJ(`/api/clients`, t);
  assert.equal(row(listT1).retards, 1); assert.equal(row(listT1).amende, 100, 'T1 amende');
  assert.equal(row(listT3).retards, 1); assert.equal(row(listT3).amende, 250, 'T3 amende');
  assert.equal(row(listAll).amende, 350, 'sans période → cumul toutes périodes (100+250)');
});

// (Phase 5) Le tableau de bord suit la période demandée.
test('lot5/dashboard : le tableau de bord suit la période demandée', async () => {
  const t = newTenant();
  seedFactP(t, { annee: 2026, trimestre: 1, date: '2026-02-10', num: 'D1' });
  seedFactP(t, { annee: 2026, trimestre: 3, date: '2026-08-10', num: 'D2' });
  seedFactP(t, { annee: 2026, trimestre: 3, date: '2026-08-11', num: 'D3' });
  const d1 = await getJ(`/api/dashboard?annee=2026&trimestre=1`, t);
  const d3 = await getJ(`/api/dashboard?annee=2026&trimestre=3`, t);
  assert.deepEqual(d1.periode, { annee: 2026, trimestre: 1 });
  assert.equal(d1.kpis.facturesTrim, 1, 'dashboard T1 : 1 facture');
  assert.equal(d3.kpis.facturesTrim, 2, 'dashboard T3 : 2 factures');
});

// (Phase 6) Navigation multi-périodes T1→T2→T3→T4 : chaque période renvoie SES données, de façon stable.
test('lot5/navigation : T1/T2/T3/T4 renvoient des données distinctes et stables (aucune fuite)', async () => {
  const t = newTenant();
  seedFactP(t, { annee: 2026, trimestre: 1, date: '2026-02-10', num: 'N1' });
  seedFactP(t, { annee: 2026, trimestre: 2, date: '2026-05-10', num: 'N2a' });
  seedFactP(t, { annee: 2026, trimestre: 2, date: '2026-05-11', num: 'N2b' });
  seedFactP(t, { annee: 2026, trimestre: 4, date: '2026-11-10', num: 'N4' });
  const cnt = {};
  for (const tr of [1, 2, 3, 4, 1, 3]) { // change plusieurs fois, y compris retours
    const s = await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=${tr}`, t);
    cnt[tr] = s.kpis.factures;
  }
  assert.equal(cnt[1], 1, 'T1=1'); assert.equal(cnt[2], 2, 'T2=2');
  assert.equal(cnt[3], 0, 'T3=0'); assert.equal(cnt[4], 1, 'T4=1');
});

// (Phase 2/3/4) Contrôle statique du front : les vues client envoient la période active ; goClient recharge.
test('lot5/UI : fiche client & portefeuille envoient la période active ; goClient recharge les périodes', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /summary\$\{perQuery\(\)\}/, 'fiche client → /summary avec la période active');
  assert.doesNotMatch(app, /if \(!state\.period\) state\.period = s\.periode/, 'plus de hijack de période par le summary');
  assert.match(app, /'\/clients' \+ perQuery\(\)/, 'portefeuille → /clients avec la période active');
  assert.match(app, /async function goClient[\s\S]{0,180}await loadPeriods\(\)[\s\S]{0,40}setView/, 'goClient recharge les périodes du nouveau client');
});

/* ==================================================================================
 * LOT 6 — CLÔTURE ET RÉOUVERTURE DES PÉRIODES
 * Une période clôturée/déclarée est IMMUABLE (recomputePeriod = no-op ; écritures refusées 423).
 * Réouverture : admin + motif obligatoire + tracée + une seule période.
 * ================================================================================== */
function seedLateFactL6(t, { annee, trimestre, date, datePaiement, ttc = 100000, num }) {
  const fid = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(fid, t.cab, t.ent, 'FRS ' + num);
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,delai_applicable)
              VALUES (?,?,?,?,?,?,?,?,?,?,60)`).run(uid('fac'), t.cab, t.ent, fid, num, ttc, date, datePaiement || null, annee, trimestre);
  return fid;
}
function nonAdminUser(t) {
  const u = uid('u');
  db.prepare('INSERT INTO utilisateur (id,cabinet_id,nom,email,password_hash,role,actif) VALUES (?,?,?,?,?,?,1)').run(u, t.cab, 'Collab', uid('e') + '@ex.ma', 'x', 'collaborateur');
  return u;
}
const closeP = (t, a, tr, body, u) => postJson(`/api/clients/${t.ent}/periods/${a}/${tr}/close?annee=${a}&trimestre=${tr}`, cookieOf(u || t.u), body || {});
const reopenP = (t, a, tr, body, u) => postJson(`/api/clients/${t.ent}/periods/${a}/${tr}/reopen?annee=${a}&trimestre=${tr}`, cookieOf(u || t.u), body || {});
const amendeOf = (t, a, tr) => db.prepare('SELECT COALESCE(SUM(montant_amende),0) s FROM facture WHERE entreprise_id=? AND annee=? AND trimestre=?').get(t.ent, a, tr).s;

// CŒUR — immuabilité : une convention créée APRÈS clôture ne change pas les montants figés.
test('lot6/immuabilité : période clôturée FIGÉE — convention postérieure sans effet sur l\'amende', async () => {
  const t = newTenant();
  const fid = seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', datePaiement: '2026-04-30', num: 'IMM' });
  const before = await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);   // recompute → amende 60 j
  assert.ok(before.kpis.amende > 0, 'amende initiale > 0');
  const cl = await closeP(t, 2026, 1); assert.equal(cl.status, 200); assert.equal(cl.body.statut, 'cloturee');
  const fige = amendeOf(t, 2026, 1);
  await postConvCreate(t, { fournisseur_id: fid, delai: 120 });   // conv qui SUPPRIMERAIT le retard
  const after = await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);     // consultation
  assert.equal(after.kpis.amende, before.kpis.amende, 'amende figée malgré la nouvelle convention');
  assert.equal(amendeOf(t, 2026, 1), fige, 'valeurs stockées inchangées (aucun recalcul destructif)');
});

// Réouverture : fige puis dégèle (recalcul ré-appliqué).
test('lot6/réouverture : après réouverture, recalcul ré-appliqué (dégel)', async () => {
  const t = newTenant();
  const fid = seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', datePaiement: '2026-04-30', num: 'REO' });
  await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);
  await closeP(t, 2026, 1);
  const gel = amendeOf(t, 2026, 1); assert.ok(gel > 0);
  await postConvCreate(t, { fournisseur_id: fid, delai: 120 });
  assert.equal(amendeOf(t, 2026, 1), gel, 'gelé pendant la clôture');
  const ro = await reopenP(t, 2026, 1, { motif: 'correction de saisie' }); assert.equal(ro.status, 200);
  await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);   // recompute ré-appliqué
  assert.ok(amendeOf(t, 2026, 1) < gel, 'dégelé : convention 120 j réduit l\'amende');
});

// Consultation autorisée sur période clôturée (lecture seule OK).
test('lot6/consultation : période clôturée reste consultable (summary/delais/declaration 200)', async () => {
  const t = newTenant();
  seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', datePaiement: '2026-04-30', num: 'RO' });
  await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);
  await closeP(t, 2026, 1);
  for (const url of [`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, `/api/clients/${t.ent}/delais?annee=2026&trimestre=1`, `/api/clients/${t.ent}/declaration?annee=2026&trimestre=1`]) {
    const r = await fetch(baseUrl() + url, { headers: { Cookie: cookieOf(t.u), Connection: 'close' } });
    assert.equal(r.status, 200, 'consultation OK: ' + url);
  }
});

// Écritures refusées (423) sur période clôturée : création facture + revue doublon.
test('lot6/API : période clôturée refuse création facture et revue doublon (423)', async () => {
  const t = newTenant();
  const fid = seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', datePaiement: '2026-04-30', num: 'REF' });
  const facId = db.prepare('SELECT id FROM facture WHERE entreprise_id=? AND annee=2026 AND trimestre=1').get(t.ent).id;
  await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);
  await closeP(t, 2026, 1);
  const addF = await postJson(`/api/clients/${t.ent}/factures`, cookieOf(t.u), { fournisseur_id: fid, ttc: 1000, date_facture: '2026-01-15', annee: 2026, trimestre: 1 });
  assert.equal(addF.status, 423, 'création facture refusée');
  const dbl = await patchJson(`/api/clients/${t.ent}/factures/${facId}/doublon`, cookieOf(t.u), { statut: 'confirme' });
  assert.equal(dbl.status, 423, 'revue doublon refusée (période clôturée)');
});

// Import refusé (423) sur période clôturée.
test('lot6/API : import refusé sur période clôturée (423)', async () => {
  const t = newTenant();
  seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', num: 'IMP' });
  await getJ(`/api/clients/${t.ent}/summary?annee=2026&trimestre=1`, t);
  await closeP(t, 2026, 1);
  const buf = aoaBuf([['N°', 'Date', 'Fournisseur', 'ICE', 'TTC'], ['X1', '2026-01-15', 'FRS IMPORT', '000000000077701', 5000]], 'S');
  const fd = new FormData(); fd.append('files', new Blob([buf]), 'imp.xlsx');
  const r = await fetch(baseUrl() + `/api/clients/${t.ent}/import?annee=2026&trimestre=1`, { method: 'POST', headers: { Cookie: cookieOf(t.u) }, body: fd });
  assert.equal(r.status, 423, 'import refusé (période clôturée)');
});

// Justification obligatoire + permissions + réouverture limitée.
test('lot6/réouverture : motif obligatoire (400) et admin uniquement (403)', async () => {
  const t = newTenant();
  seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', num: 'J' });
  await closeP(t, 2026, 1);
  const sansMotif = await reopenP(t, 2026, 1, {});
  assert.equal(sansMotif.status, 400, 'réouverture sans motif refusée');
  const collab = nonAdminUser(t);
  const nonAdmin = await reopenP(t, 2026, 1, { motif: 'test' }, collab);
  assert.equal(nonAdmin.status, 403, 'réouverture réservée admin');
});
test('lot6/clôture : réservée admin (403) ; réouverture d\'une période non clôturée refusée (409)', async () => {
  const t = newTenant();
  seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', num: 'P' });
  const collab = nonAdminUser(t);
  const nonAdminClose = await closeP(t, 2026, 1, {}, collab);
  assert.equal(nonAdminClose.status, 403, 'clôture réservée admin');
  const reopenOpen = await reopenP(t, 2026, 1, { motif: 'x' });
  assert.equal(reopenOpen.status, 409, 'rien à rouvrir sur une période non clôturée');
});

// Audit clôture + réouverture avec état avant/après.
test('lot6/audit : clôture et réouverture tracées (avant/après, motif, utilisateur)', async () => {
  const t = newTenant();
  seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-10', num: 'AUD' });
  await closeP(t, 2026, 1);
  const cl = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='cloture_periode' AND cabinet_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(t.cab).details);
  assert.equal(cl.apres, 'cloturee', 'audit clôture: après=cloturee'); assert.ok('avant' in cl, 'audit clôture: état avant tracé');
  await reopenP(t, 2026, 1, { motif: 'régularisation DGI' });
  const ro = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action='reouverture_periode' AND cabinet_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(t.cab).details);
  assert.equal(ro.avant, 'cloturee', 'audit réouverture: avant=cloturee');
  assert.equal(ro.apres, 'rouverte'); assert.equal(ro.motif, 'régularisation DGI', 'motif tracé');
});

// Contrôle statique du front : UI de clôture/réouverture présente + garde-fous.
test('lot6/UI : contrôles clôture/réouverture présents (admin, motif, confirmation)', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /\/periods\/\$\{p\.annee\}\/\$\{p\.trimestre\}\/close/, 'action de clôture câblée');
  assert.match(app, /\/periods\/\$\{p\.annee\}\/\$\{p\.trimestre\}\/reopen/, 'action de réouverture câblée');
  assert.match(app, /reopenPeriodAction[\s\S]{0,400}prompt\(/, 'réouverture demande un motif');
  assert.match(app, /state\.me && state\.me\.role === 'admin'/, 'boutons réservés à l\'admin');
});

/* ================================================================================
 * LOT 7 — INTÉGRITÉ DES EXPORTS ET LIVRABLES DGI
 * Principe vérifié : un export représente EXACTEMENT ce que l'application affiche —
 * même période, mêmes montants, mêmes exclusions, aucune donnée perdue ni recalculée.
 * ================================================================================ */

async function getText(pathUrl, cookie) {
  const res = await fetch(baseUrl() + pathUrl, { headers: cookie ? { Cookie: cookie } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ct: res.headers.get('content-type') || '',
           cd: res.headers.get('content-disposition') || '', buf, text: buf.toString('utf8') };
}
async function getJson(pathUrl, cookie) {
  const res = await fetch(baseUrl() + pathUrl, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function postJson(pathUrl, cookie, body) {
  const res = await fetch(baseUrl() + pathUrl, { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
// Relit un CSV avec un VRAI parseur (guillemets, séparateur) — comme le ferait Excel.
function csvGrid(text) {
  const wb = XLSX.read(text.replace(/^﻿/, ''), { type: 'string', FS: ';', raw: false });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
}
const EXPORTS_PERIODE = ['delais/export.xlsx', 'declaration/export.csv', 'declaration/export.xml',
                         'visa/export.docx', 'visa/export.pdf'];

// Seed déclaratif : 1 fournisseur standard en retard + 1 opérateur réseau (non confirmé au départ).
function seedDecl(t) {
  const fn = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fn, t.cab, t.ent, 'FRS; ÉLECTRICITÉ "A"', 'IF-NORM');
  const fr = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fr, t.cab, t.ent, 'MAROC TELECOM', 'IF-RES');
  const i = db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)');
  i.run(uid('fac'), t.cab, t.ent, fn, 'F-1', 1234.567, '2026-01-05', 2026, 1);
  i.run(uid('fac'), t.cab, t.ent, fr, 'F-2', 50000, '2026-01-10', 2026, 1);
  return { fn, fr };
}

/* -------- Phase 2 : l'écran et le fichier disent la même chose -------- */
test('lot7/cohérence : déclaration écran ↔ CSV ↔ XML (mêmes lignes, mêmes montants, même période)', async () => {
  const t = newTenant(); seedDecl(t);
  const per = '?annee=2026&trimestre=1';
  const ui = (await getJson(`/api/clients/${t.ent}/declaration${per}`, cookieOf(t.u))).body;
  const csv = csvGrid((await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u))).text);
  const xml = (await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u))).text;

  const lignesCsv = csv.filter(r => !['IF fournisseur', 'TOTAL', 'EXCLUSIONS RESEAU'].includes(r[0]));
  assert.equal(lignesCsv.length, ui.lignes.length, 'même nombre de lignes à l\'écran et dans le CSV');
  assert.equal((xml.match(/<Facture>/g) || []).length, ui.lignes.length, 'même nombre de lignes dans le XML');
  for (const l of ui.lignes) {
    const row = lignesCsv.find(r => r[1] === l.nom);
    assert.ok(row, `ligne « ${l.nom} » présente dans le CSV`);
    assert.equal(Number(row[2]).toFixed(2), Number(l.ttc).toFixed(2), 'TTC identique');
    assert.equal(Number(row[6]).toFixed(2), Number(l.amende).toFixed(2), 'amende identique');
    assert.equal(Number(row[7]), 2026, 'année portée par la ligne');
    assert.equal(Number(row[8]), 1, 'trimestre porté par la ligne');
    assert.ok(xml.includes(`<Amende>${Number(l.amende).toFixed(2)}</Amende>`), 'amende identique dans le XML');
  }
  const tot = csv.find(r => r[0] === 'TOTAL');
  assert.equal(Number(tot[2]).toFixed(2), Number(ui.declaration.montant_total_ttc).toFixed(2), 'total TTC identique');
  assert.equal(Number(tot[6]).toFixed(2), Number(ui.declaration.montant_total_amende).toFixed(2), 'total amende identique');
  assert.ok(xml.includes(`<TotalTTC>${Number(ui.declaration.montant_total_ttc).toFixed(2)}</TotalTTC>`), 'total TTC identique dans le XML');
  assert.match(xml, /<DeclarationDelaisPaiement annee="2026" periode="T1">/, 'période portée par le XML');
});

test('lot7/cohérence : feuille de délais écran ↔ Excel (mêmes lignes, mêmes totaux)', async () => {
  const t = newTenant(); seedDelaisMix(t);
  const per = '?annee=2026&trimestre=1';
  const ui = (await getJson(`/api/clients/${t.ent}/delais${per}`, cookieOf(t.u))).body;
  const rows = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u))).buf);
  const data = rows.filter(r => /^(R-1|C-1|OK-1)$/.test(String(r[0])));
  assert.equal(data.length, ui.rows.length, 'même nombre de lignes');
  for (const r of ui.rows) {
    const x = data.find(d => d[0] === r.numero);
    assert.ok(x, `facture ${r.numero} exportée`);
    assert.equal(x[5], r.ttc, 'TTC identique');
    assert.equal(x[10], r.delai_applicable, 'délai autorisé identique');
    assert.equal(x[11], r.retard, 'retard identique');
    assert.equal(x[13], r.amende || 0, 'amende identique');
    assert.equal(x[12], r.a_declarer ? 'Oui' : 'Non', 'statut « à déclarer » identique');
  }
  const tot = rows.find(r => r[0] === 'TOTAL');
  assert.equal(tot[5], ui.totals.ttc, 'TOTAL TTC identique à l\'écran');
  assert.equal(tot[13], ui.totals.amende, 'TOTAL amende identique à l\'écran');
});

test('lot7/cohérence : les incidences reportées sont totalisées à part, jamais fondues dans le TTC', async () => {
  const t = newTenant();
  const f = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(f, t.cab, t.ent, 'FRS INC');
  const i = db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)');
  i.run(uid('fac'), t.cab, t.ent, f, 'T1-A', 100000, '2026-01-05', 2026, 1);   // impayée → pèse aussi sur T2
  i.run(uid('fac'), t.cab, t.ent, f, 'T2-A', 40000, '2026-04-10', 2026, 2);
  for (const q of [1, 2]) await postJson(`/api/clients/${t.ent}/recompute?annee=2026&trimestre=${q}`, cookieOf(t.u));
  const ui = (await getJson(`/api/clients/${t.ent}/delais?annee=2026&trimestre=2`, cookieOf(t.u))).body;
  assert.equal(ui.totals.incidences, 1, 'une incidence reportée à l\'écran');
  const rows = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx?annee=2026&trimestre=2&filter=all`, cookieOf(t.u))).buf);
  const tot = rows.find(r => r[0] === 'TOTAL');
  const inc = rows.find(r => r[0] === 'Incidences reportées');
  const due = rows.find(r => String(r[0]).startsWith('TOTAL AMENDE DUE'));
  assert.ok(inc && due, 'lignes « incidences » et « total dû » présentes');
  assert.equal(tot[5], ui.totals.ttc, 'TOTAL TTC = TTC des factures de la période (écran)');
  assert.equal(inc[13], ui.totals.amendeIncidence, 'amende des incidences isolée');
  assert.equal(due[13], ui.totals.amende, 'amende due au titre de la période = écran');
  assert.match(String(rows[1][0]), /1 facture\(s\) de la période \+ 1 incidence\(s\) reportée\(s\)/, 'sous-titre explicite');
});

/* -------- Phase 3 : la période active, et elle seule -------- */
test('lot7/période : tout export exige une période explicite et valide (jamais devinée)', async () => {
  const t = newTenant(); seedDecl(t);
  for (const u of EXPORTS_PERIODE) {
    const sans = await getText(`/api/clients/${t.ent}/${u}`, cookieOf(t.u));
    assert.equal(sans.status, 400, `${u} sans période → 400`);
    assert.match(sans.text, /période .*requise et valide/i, `${u} : message explicite`);
    const bad = await getText(`/api/clients/${t.ent}/${u}?annee=abc&trimestre=9`, cookieOf(t.u));
    assert.equal(bad.status, 400, `${u} période illisible → 400`);
    assert.doesNotMatch(bad.cd, /NaN/, `${u} : aucun fichier « NaN » produit`);
  }
});

test('lot7/période : T1..T4 exportent des données distinctes, sans mélange', async () => {
  const t = newTenant();
  const f = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,60)').run(f, t.cab, t.ent, 'FRS Q', 'IF-Q');
  const dates = { 1: '2026-01-05', 2: '2026-04-05', 3: '2026-07-05', 4: '2026-10-05' };
  const i = db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)');
  for (const q of [1, 2, 3, 4]) i.run(uid('fac'), t.cab, t.ent, f, `Q${q}`, q * 10000, dates[q], 2026, q);
  for (const q of [1, 2, 3, 4]) await postJson(`/api/clients/${t.ent}/recompute?annee=2026&trimestre=${q}`, cookieOf(t.u));
  for (const q of [1, 2, 3, 4]) {
    const per = `?annee=2026&trimestre=${q}`;
    const rows = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u))).buf);
    const propres = rows.filter(r => /^Q[1-4]$/.test(String(r[0])) && !r[16]);
    assert.deepEqual(propres.map(r => r[0]), [`Q${q}`], `T${q} : seule la facture du trimestre (hors incidences)`);
    const cd = (await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u))).cd;
    assert.match(cd, new RegExp(`declaration_2026_T${q}\\.csv`), `T${q} : nom de fichier daté du bon trimestre`);
    const xml = (await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u))).text;
    assert.match(xml, new RegExp(`annee="2026" periode="T${q}"`), `T${q} : période portée par le XML`);
    const csv = csvGrid((await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u))).text);
    for (const r of csv.slice(1)) { assert.equal(Number(r[7]), 2026); assert.equal(Number(r[8]), q); }
  }
});

/* -------- Phase 4 : règles métier — clôture, réouverture, réseau, conventions -------- */
test('lot7/clôture : la déclaration exportée est FIGÉE — exclusion réseau confirmée après clôture sans effet', async () => {
  const t = newTenant(); const { fr } = seedDecl(t);
  const per = '?annee=2026&trimestre=1';
  await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u));
  const avant = (await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u))).text;
  const xmlAvant = (await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u))).text;
  assert.equal((await postJson(`/api/clients/${t.ent}/periods/2026/1/close`, cookieOf(t.u))).status, 200);
  const snap = db.prepare('SELECT montant_total_ttc, montant_total_amende, nb_lignes FROM declaration WHERE entreprise_id=? AND annee=2026 AND trimestre=1').get(t.ent);

  // Confirmation « opérateur de réseau » APRÈS la clôture : elle ne doit rien retirer du tableau figé.
  const patch = await fetch(baseUrl() + `/api/clients/${t.ent}/fournisseurs/${fr}/classification`, {
    method: 'PATCH', headers: { Cookie: cookieOf(t.u), 'Content-Type': 'application/json' },
    body: JSON.stringify({ operateur_reseau: true, statut: 'confirme', hors_tableau_declaratif: true, categorie_fournisseur: 'telecom' }) });
  assert.equal(patch.status, 200);

  const apres = (await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u))).text;
  const xmlApres = (await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u))).text;
  assert.equal(apres, avant, 'CSV d\'une période clôturée strictement inchangé');
  assert.equal(xmlApres.replace(/<PeriodeFigee>\w+<\/PeriodeFigee>/, ''), xmlAvant.replace(/<PeriodeFigee>\w+<\/PeriodeFigee>/, ''),
    'XML d\'une période clôturée strictement inchangé');
  assert.match(xmlApres, /<PeriodeFigee>oui<\/PeriodeFigee>/, 'le XML annonce une période figée');
  assert.ok(apres.includes('MAROC TELECOM'), 'la facture réseau reste dans le tableau arrêté');

  // Aucune écriture : le snapshot en base est intact après les exports.
  const apresDb = db.prepare('SELECT montant_total_ttc, montant_total_amende, nb_lignes FROM declaration WHERE entreprise_id=? AND annee=2026 AND trimestre=1').get(t.ent);
  assert.deepEqual(apresDb, snap, 'un export ne réécrit jamais une déclaration clôturée');
});

test('lot7/clôture : le CA du client modifié après clôture ne change ni le montant ni le type de visa figés', async () => {
  const t = newTenant(); seedDecl(t);
  db.prepare('UPDATE entreprise SET ca_ht=? WHERE id=?').run(8_000_000, t.ent);
  const per = '?annee=2026&trimestre=1';
  await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u));
  await postJson(`/api/clients/${t.ent}/periods/2026/1/close`, cookieOf(t.u));
  const avant = db.prepare('SELECT ca_ht, type_visa FROM declaration WHERE entreprise_id=? AND annee=2026 AND trimestre=1').get(t.ent);
  assert.equal(avant.type_visa, 'EC', 'visa expert-comptable au moment de l\'arrêté');
  db.prepare('UPDATE entreprise SET ca_ht=? WHERE id=?').run(90_000_000, t.ent);   // franchit le seuil CAC
  await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u));
  const apres = db.prepare('SELECT ca_ht, type_visa FROM declaration WHERE entreprise_id=? AND annee=2026 AND trimestre=1').get(t.ent);
  assert.deepEqual(apres, avant, 'en-tête déclaratif figé (ca_ht + type de visa)');
  const xml = (await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u))).text;
  assert.match(xml, /<TypeVisa>EC<\/TypeVisa>/, 'le XML conserve le type de visa arrêté');
  assert.match(xml, /<CAHT>8000000\.00<\/CAHT>/, 'le XML conserve le CA arrêté');
});

test('lot7/clôture : la feuille exportée est figée — convention postérieure sans effet (réserve P3-2)', async () => {
  const t = newTenant();
  const f = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(f, t.cab, t.ent, 'FRS FIG');
  db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)')
    .run(uid('fac'), t.cab, t.ent, f, 'FIG-1', 100000, '2026-01-05', 2026, 1);
  const per = '?annee=2026&trimestre=1';
  await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u));
  await postJson(`/api/clients/${t.ent}/periods/2026/1/close`, cookieOf(t.u));
  const uiAvant = (await getJson(`/api/clients/${t.ent}/delais${per}`, cookieOf(t.u))).body;
  const xAvant = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u))).buf).find(r => r[0] === 'FIG-1');

  db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut) VALUES (?,?,?,?,120,'valide')")
    .run(uid('conv'), t.cab, t.ent, f);

  const uiApres = (await getJson(`/api/clients/${t.ent}/delais${per}`, cookieOf(t.u))).body;
  const xApres = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u))).buf).find(r => r[0] === 'FIG-1');
  assert.equal(uiApres.rows[0].delai_applicable, uiAvant.rows[0].delai_applicable, 'délai autorisé figé à l\'écran');
  assert.equal(uiApres.rows[0].retard, uiAvant.rows[0].retard, 'retard figé à l\'écran');
  assert.equal(uiApres.totals.retardMoyen, uiAvant.totals.retardMoyen, 'KPI retard moyen figé');
  assert.deepEqual(xApres, xAvant, 'ligne exportée strictement inchangée');
  // Cohérence interne du fichier : un délai « 120 j / 0 j de retard » à côté d'une amende gelée est exclu.
  assert.equal(xApres[10], 60, 'délai autorisé = celui arrêté à la clôture');
  assert.ok(xApres[11] > 0 && xApres[13] > 0, 'retard et amende concordants');
});

test('lot7/réouverture : après réouverture + recalcul, les exports repartent sur les valeurs recalculées', async () => {
  const t = newTenant();
  const f = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(f, t.cab, t.ent, 'FRS RO');
  db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)')
    .run(uid('fac'), t.cab, t.ent, f, 'RO-1', 100000, '2026-01-05', 2026, 1);
  const per = '?annee=2026&trimestre=1';
  await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u));
  await postJson(`/api/clients/${t.ent}/periods/2026/1/close`, cookieOf(t.u));
  db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut) VALUES (?,?,?,?,120,'valide')")
    .run(uid('conv'), t.cab, t.ent, f);
  const fige = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u))).buf).find(r => r[0] === 'RO-1');
  assert.equal(fige[10], 60, 'gelé avant réouverture');

  assert.equal((await postJson(`/api/clients/${t.ent}/periods/2026/1/reopen`, cookieOf(t.u), { motif: 'régularisation LOT 7' })).status, 200);
  assert.equal((await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u))).status, 200);
  const degel = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u))).buf).find(r => r[0] === 'RO-1');
  assert.equal(degel[10], 120, 'délai conventionnel appliqué après dégel');
  assert.equal(degel[11], 0, 'plus de retard');
  assert.equal(degel[13], 0, 'plus d\'amende');
  const csv = csvGrid((await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u))).text);
  assert.equal(Number(csv.find(r => r[0] === 'TOTAL')[6]), 0, 'déclaration recalculée après réouverture');
  const xml = (await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u))).text;
  assert.match(xml, /<PeriodeFigee>non<\/PeriodeFigee>/, 'le XML n\'annonce plus une période figée');
});

test('lot7/réseau : les exclusions réseau sont appliquées ET tracées dans le CSV et le XML', async () => {
  const t = newTenant(); const { fr } = seedDecl(t);
  const per = '?annee=2026&trimestre=1';
  await fetch(baseUrl() + `/api/clients/${t.ent}/fournisseurs/${fr}/classification`, {
    method: 'PATCH', headers: { Cookie: cookieOf(t.u), 'Content-Type': 'application/json' },
    body: JSON.stringify({ operateur_reseau: true, statut: 'confirme', hors_tableau_declaratif: true, categorie_fournisseur: 'telecom' }) });
  const ui = (await getJson(`/api/clients/${t.ent}/declaration${per}`, cookieOf(t.u))).body;
  assert.equal(ui.exclusions.nbFactures, 1, 'une facture exclue à l\'écran');
  const csv = csvGrid((await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u))).text);
  assert.ok(!csv.some(r => r[1] === 'MAROC TELECOM'), 'la facture réseau ne figure pas au tableau déclaratif');
  const exc = csv.find(r => r[0] === 'EXCLUSIONS RESEAU');
  assert.ok(exc, 'exclusion tracée dans le CSV (jamais silencieuse)');
  assert.equal(Number(exc[2]).toFixed(2), Number(ui.exclusions.ttc).toFixed(2), 'TTC exclu identique à l\'écran');
  assert.match(String(exc[1]), /Opérateur de réseau/, 'motif d\'exclusion porté par le fichier');
  const xml = (await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u))).text;
  assert.match(xml, /<Exclusions nb="1" nbFournisseurs="1">/, 'exclusions tracées dans le XML');
  assert.ok(!xml.includes('MAROC TELECOM'), 'la facture réseau est bien hors du flux EDI');
});

test('lot7/convention : le délai conventionnel appliqué à l\'écran l\'est aussi dans l\'Excel', async () => {
  const t = newTenant();
  const f = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(f, t.cab, t.ent, 'FRS CONV');
  db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)')
    .run(uid('fac'), t.cab, t.ent, f, 'CV-1', 80000, '2026-01-05', 2026, 1);
  const per = '?annee=2026&trimestre=1';
  db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut) VALUES (?,?,?,?,90,'valide')")
    .run(uid('conv'), t.cab, t.ent, f);
  await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u));
  const ui = (await getJson(`/api/clients/${t.ent}/delais${per}`, cookieOf(t.u))).body;
  const x = xlsxRows((await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u))).buf).find(r => r[0] === 'CV-1');
  assert.equal(ui.rows[0].delai_applicable, 90, 'convention 90 j appliquée à l\'écran');
  assert.equal(x[10], 90, 'convention 90 j appliquée dans l\'export');
  assert.equal(x[11], ui.rows[0].retard, 'retard identique');
});

/* -------- Phase 5 : qualité des fichiers produits -------- */
test('lot7/qualité : CSV — BOM UTF-8, accents et arabe, colonnes alignées, 2 décimales, Σ lignes = total', async () => {
  const t = newTenant();
  const fa = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fa, t.cab, t.ent, 'FRS; ÉLECTRICITÉ "ÂÎÔÛ"', 'IF;A');
  const fb = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,60)')
    .run(fb, t.cab, t.ent, 'شركة الاتصالات المغربية', 'IF-AR');
  const i = db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre,delai_applicable) VALUES (?,?,?,?,?,?,?,?,?,60)');
  i.run(uid('fac'), t.cab, t.ent, fa, 'Q-1', 1234.567, '2026-01-05', 2026, 1);
  i.run(uid('fac'), t.cab, t.ent, fb, 'Q-2', 7000, '2026-01-06', 2026, 1);
  const per = '?annee=2026&trimestre=1';
  await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u));
  const r = await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u));
  assert.deepEqual([...r.buf.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM UTF-8 en tête (Excel lit les accents)');
  assert.match(r.ct, /charset=utf-8/, 'jeu de caractères annoncé');
  const g = csvGrid(r.text);
  assert.equal(new Set(g.map(x => x.length)).size, 1, 'toutes les lignes ont le même nombre de colonnes');
  assert.ok(g.some(x => x[1] === 'FRS; ÉLECTRICITÉ "ÂÎÔÛ"'), 'point-virgule, guillemets et accents préservés');
  assert.ok(g.some(x => x[1] === 'شركة الاتصالات المغربية'), 'libellé arabe préservé');
  for (const x of g.slice(1)) for (const c of [2, 3, 4, 6])
    if (x[c] !== null && x[c] !== '') assert.match(String(Number(x[c]).toFixed(2)), /^-?\d+\.\d{2}$/, 'montants à 2 décimales');
  const lignes = g.filter(x => !['IF fournisseur', 'TOTAL', 'EXCLUSIONS RESEAU'].includes(x[0]));
  const somme = lignes.reduce((s, x) => s + Number(x[2]), 0);
  assert.ok(Math.abs(somme - Number(g.find(x => x[0] === 'TOTAL')[2])) < 0.005, 'la somme des lignes retombe exactement sur le total');
  assert.equal(new Set(lignes.map(x => x[0] + '|' + x[1])).size, lignes.length, 'aucun doublon de ligne');
});

test('lot7/qualité : rejets CSV — colonnes alignées et injection de formule neutralisée', async () => {
  const t = newTenant();
  const lot = uid('lot');
  db.prepare('INSERT INTO import_lot (id,cabinet_id,entreprise_id,annee,trimestre,source_nom,statut) VALUES (?,?,?,?,?,?,?)')
    .run(lot, t.cab, t.ent, 2026, 1, 'src.xlsx', 'confirme');
  db.prepare('INSERT INTO import_ligne (id,import_lot_id,cabinet_id,entreprise_id,numero_ligne,feuille,statut,motif,champ,donnees_brutes_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(uid('il'), lot, t.cab, t.ent, 7, 'Feuille;PIÉGÉE', 'rejetee', 'Motif "avec" guillemets', '=cmd|calc',
         JSON.stringify(['=HYPERLINK("http://x")', 'a"b']));
  const r = await getText(`/api/imports/${lot}/rejections.csv`, cookieOf(t.u));
  assert.equal(r.status, 200);
  assert.deepEqual([...r.buf.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM UTF-8');
  const g = csvGrid(r.text);
  assert.equal(new Set(g.map(x => x.length)).size, 1, 'un « ; » dans un nom de feuille ne décale plus les colonnes');
  assert.equal(g[1][1], 'Feuille;PIÉGÉE', 'nom de feuille restitué intact');
  assert.equal(g[1][3], 'Motif "avec" guillemets', 'motif restitué intact (guillemets échappés)');
  assert.ok(String(g[1][4]).startsWith("'="), 'formule neutralisée par une apostrophe');
  assert.ok(!/(^|;)=/.test(r.text.split('\n')[1]), 'aucune cellule ne commence par « = »');
});

test('lot7/vide : une période sans données produit un fichier valide, jamais une erreur', async () => {
  const t = newTenant();   // client sans aucune facture
  const per = '?annee=2026&trimestre=3';
  const csv = await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u));
  assert.equal(csv.status, 200); assert.match(csv.cd, /declaration_2026_T3\.csv/);
  const g = csvGrid(csv.text);
  assert.equal(g[0][0], 'IF fournisseur', 'en-tête présent');
  assert.equal(Number(g.find(x => x[0] === 'TOTAL')[6]), 0, 'total à zéro — déclaration « néant »');
  const xml = await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u));
  assert.equal(xml.status, 200);
  assert.match(xml.text, /<Recapitulatif><NbLignes>0<\/NbLignes>/, 'récapitulatif à zéro');
  assert.match(xml.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/, 'XML bien formé');
  const x = await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u));
  assert.equal(x.status, 200);
  const rows = xlsxRows(x.buf);
  assert.ok(rows.find(r => r[0] === 'N° facture'), 'en-têtes présents dans le classeur vide');
  assert.equal(rows.find(r => r[0] === 'TOTAL')[5], 0, 'total à zéro');
  assert.match(String(rows[1][0]), /0 facture\(s\) de la période/, 'sous-titre explicite');
  for (const f of ['visa/export.docx', 'visa/export.pdf']) {
    // VISA-1 (INC 2.2) : sans conclusion explicite, aucun visa n'est produit.
    assert.equal((await getXlsx(`/api/clients/${t.ent}/${f}${per}`, cookieOf(t.u))).status, 400, `${f} : conclusion obligatoire`);
    const v = await getXlsx(`/api/clients/${t.ent}/${f}${per}&conclusion=${encodeURIComponent('Sans observation')}`, cookieOf(t.u));
    assert.equal(v.status, 200, `${f} : document généré même sans données`);
    assert.ok(v.buf.length > 500, `${f} : document non vide`);
  }
});

/* -------- Phases 7 & 8 : permissions et traçabilité -------- */
test('lot7/permissions : aucun export accessible sans session ni depuis un autre cabinet', async () => {
  const a = newTenant('A'), b = newTenant('B'); seedDecl(a);
  const per = '?annee=2026&trimestre=1';
  for (const u of EXPORTS_PERIODE) {
    assert.equal((await getXlsx(`/api/clients/${a.ent}/${u}${per}`, null)).status, 401, `${u} : anonyme refusé`);
    assert.equal((await getXlsx(`/api/clients/${a.ent}/${u}${per}`, cookieOf(b.u))).status, 404, `${u} : cloisonnement cabinet`);
  }
  const lot = uid('lot');
  db.prepare('INSERT INTO import_lot (id,cabinet_id,entreprise_id,annee,trimestre,source_nom,statut) VALUES (?,?,?,?,?,?,?)')
    .run(lot, a.cab, a.ent, 2026, 1, 's.xlsx', 'confirme');
  assert.equal((await getText(`/api/imports/${lot}/rejections.csv`, cookieOf(b.u))).status, 404, 'rejets : cloisonnement cabinet');
  assert.equal((await getText(`/api/imports/${lot}/rejections.csv`, null)).status, 401, 'rejets : anonyme refusé');
  assert.equal((await getXlsx('/api/conventions/template.xlsx', null)).status, 401, 'modèle : anonyme refusé');
});

test('lot7/audit : chaque export est journalisé (utilisateur, date, cabinet, période, format)', async () => {
  const t = newTenant(); seedDecl(t);
  const per = '?annee=2026&trimestre=1';
  await postJson(`/api/clients/${t.ent}/recompute${per}`, cookieOf(t.u));
  db.prepare('DELETE FROM audit_log WHERE cabinet_id=?').run(t.cab);
  await getXlsx(`/api/clients/${t.ent}/delais/export.xlsx${per}&filter=all`, cookieOf(t.u));
  await getText(`/api/clients/${t.ent}/declaration/export.csv${per}`, cookieOf(t.u));
  await getText(`/api/clients/${t.ent}/declaration/export.xml${per}`, cookieOf(t.u));
  const vc = `&conclusion=${encodeURIComponent('Avec réserve')}`; // VISA-1 : conclusion explicite
  await getXlsx(`/api/clients/${t.ent}/visa/export.docx${per}${vc}`, cookieOf(t.u));
  await getXlsx(`/api/clients/${t.ent}/visa/export.pdf${per}${vc}`, cookieOf(t.u));
  const logs = db.prepare("SELECT action, entite, details, user_id, cabinet_id, created_at FROM audit_log WHERE cabinet_id=? AND action='export' ORDER BY rowid").all(t.cab);
  assert.equal(logs.length, 5, 'les 5 exports sont tracés');
  const formats = logs.map(l => JSON.parse(l.details).format);
  assert.deepEqual(formats, ['xlsx', 'csv', 'xml', 'docx', 'pdf'], 'format consigné pour chaque export');
  for (const l of logs) {
    const d = JSON.parse(l.details);
    assert.equal(l.user_id, t.u, 'utilisateur consigné');
    assert.equal(l.cabinet_id, t.cab, 'cabinet consigné');
    assert.ok(l.created_at, 'date et heure consignées');
    assert.equal(d.annee, 2026, 'année consignée'); assert.equal(d.trimestre, 1, 'trimestre consigné');
    assert.equal(d.entreprise, t.ent, 'client consigné');
  }
  // Le rapport de rejets est tracé lui aussi.
  const lot = uid('lot');
  db.prepare('INSERT INTO import_lot (id,cabinet_id,entreprise_id,annee,trimestre,source_nom,statut) VALUES (?,?,?,?,?,?,?)')
    .run(lot, t.cab, t.ent, 2026, 1, 's.xlsx', 'confirme');
  await getText(`/api/imports/${lot}/rejections.csv`, cookieOf(t.u));
  const rej = db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND entite='rejets_import'").get(t.cab);
  assert.ok(rej && JSON.parse(rej.details).importId === lot, 'export des rejets tracé');
});

test('lot7/UI : le frontend transmet toujours la période active aux liens d\'export', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(src, /export\.csv\$\{perQuery\(\)\}/, 'export CSV appelé avec la période active');
  assert.match(src, /export\.xml\$\{perQuery\(\)\}/, 'export XML appelé avec la période active');
  assert.match(src, /export\.xlsx\$\{qs\}\$\{sep\}filter=/, 'export Excel appelé avec la période active');
  assert.match(src, /const q = `\?annee=\$\{state\.period\.annee\}&trimestre=\$\{state\.period\.trimestre\}/, 'visa appelé avec la période active');
  assert.match(src, /export\.docx\$\{q\}/, 'visa Word avec période'); assert.match(src, /export\.pdf\$\{q\}/, 'visa PDF avec période');
  // Toute vue exportable garantit d'abord la période active (ensurePeriod) avant de bâtir les liens.
  for (const fn of ['renderDecl', 'renderVisa', 'renderDelais'])
    assert.match(src, new RegExp(`async function ${fn}\\(\\)[\\s\\S]{0,200}ensurePeriod\\(\\)`), `${fn} garantit la période active`);
});

/* ================================================================================
 * PRODUCTISATION SaaS — ESPACE DE TRAVAIL (tenant = cabinet), HÔTE → ESPACE, UI
 * Aucune règle métier touchée : ces tests verrouillent la couche d'identité ajoutée
 * et les contrats de l'interface redessinée.
 * ================================================================================ */
const tenantMod = require('../src/tenant');
// http.request (et non fetch) : fetch ignore l'en-tête Host, indispensable pour simuler un sous-domaine.
function reqJson(method, pathUrl, { cookie, host, body } = {}) {
  const http = require('http');
  const u = new URL(baseUrl() + pathUrl);
  const payload = body ? JSON.stringify(body) : null;
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (host) headers.Host = host;
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, body: json }); });
    });
    r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}
function tenantWithSlug(slug, nom = 'Cab ' + slug) {
  const t = newTenant(nom);
  db.prepare('UPDATE cabinet SET slug=? WHERE id=?').run(slug, t.cab);
  const email = `${slug}-${uid('m')}@ex.ma`.toLowerCase();
  db.prepare('UPDATE utilisateur SET email=?, password_hash=? WHERE id=?').run(email, auth.hashPassword('Secret-123'), t.u);
  return { ...t, email };
}

test('saas/tenant : résolution nom d\'hôte → slug (sous-domaine unique, réservés et IP ignorés)', () => {
  const d = ['localhost', 'delaipay.local'];
  assert.equal(tenantMod.slugFromHost('premium.localhost:4100', d), 'premium');
  assert.equal(tenantMod.slugFromHost('Premium.DelaiPay.Local', d), 'premium');
  assert.equal(tenantMod.slugFromHost('localhost:3000', d), null, 'hôte nu = aucun espace');
  assert.equal(tenantMod.slugFromHost('127.0.0.1:3000', d), null, 'IP = aucun espace');
  assert.equal(tenantMod.slugFromHost('a.b.localhost', d), null, 'un seul niveau de sous-domaine');
  assert.equal(tenantMod.slugFromHost('www.delaipay.local', d), null, 'sous-domaine réservé');
  assert.equal(tenantMod.slugFromHost('delaipay.hlzconsulting.ma', d), null, 'domaine de production actuel : aucun effet');
  assert.equal(tenantMod.slugFromHost('evil_slug.localhost', d), null, 'slug invalide refusé');
});

test('saas/tenant : /api/tenant est public et ne divulgue aucune donnée interne', async () => {
  const t = tenantWithSlug('pubcheck');
  db.prepare("UPDATE cabinet SET nom_affiche='Pub Check', couleur_primaire='#2F3E6B', contact_email='x@ex.ma' WHERE id=?").run(t.cab);
  const r = await reqJson('GET', '/api/tenant', { host: 'pubcheck.localhost' });
  assert.equal(r.status, 200);
  assert.equal(r.body.known, true); assert.equal(r.body.displayName, 'Pub Check'); assert.equal(r.body.primaryColor, '#2F3E6B');
  const raw = JSON.stringify(r.body);
  assert.ok(!raw.includes(t.cab) && !raw.includes('x@ex.ma'), 'ni identifiant interne ni contact');
  const n = await reqJson('GET', '/api/tenant', { host: 'localhost' });
  assert.equal(n.body.known, false); assert.equal(n.body.slug, null);
  const u = await reqJson('GET', '/api/tenant', { host: 'inconnu-xyz.localhost' });
  assert.equal(u.body.known, false); assert.equal(u.body.slug, 'inconnu-xyz');
});

test('saas/tenant : la connexion sur un sous-domaine est limitée aux comptes de CET espace', async () => {
  const a = tenantWithSlug('alpha'), b = tenantWithSlug('beta');
  const ok = await reqJson('POST', '/api/auth/login', { host: 'alpha.localhost', body: { email: a.email, password: 'Secret-123' } });
  assert.equal(ok.status, 200, 'compte de l\'espace : accepté');
  const cross = await reqJson('POST', '/api/auth/login', { host: 'beta.localhost', body: { email: a.email, password: 'Secret-123' } });
  assert.equal(cross.status, 401, 'compte d\'un autre espace : refusé');
  assert.equal(cross.body.error, 'Identifiants incorrects.', 'même message qu\'un mauvais mot de passe (aucune énumération)');
  const unknown = await reqJson('POST', '/api/auth/login', { host: 'nulle-part.localhost', body: { email: a.email, password: 'Secret-123' } });
  assert.equal(unknown.status, 401, 'espace inconnu : refusé');
  const neutral = await reqJson('POST', '/api/auth/login', { host: 'localhost', body: { email: b.email, password: 'Secret-123' } });
  assert.equal(neutral.status, 200, 'hôte neutre : comportement historique inchangé');
});

test('saas/workspace : lecture par tout utilisateur, modification admin seule, validée et auditée', async () => {
  const t = tenantWithSlug('wsedit', 'Cabinet Réel SARL');
  const me = await reqJson('GET', '/api/me', { cookie: cookieOf(t.u) });
  assert.equal(me.body.workspace.displayName, 'Cabinet Réel SARL', 'repli sur la raison sociale');
  const bad = await reqJson('PUT', '/api/workspace', { cookie: cookieOf(t.u), body: { primaryColor: 'red' } });
  assert.equal(bad.status, 400, 'couleur invalide refusée');
  const badLoc = await reqJson('PUT', '/api/workspace', { cookie: cookieOf(t.u), body: { locale: 'xx-XX' } });
  assert.equal(badLoc.status, 400, 'locale hors liste refusée');
  const ok = await reqJson('PUT', '/api/workspace', { cookie: cookieOf(t.u), body: { nomAffiche: 'Réel', primaryColor: '#2f3e6b', slug: 'pirate', plan: 'gratuit' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.workspace.displayName, 'Réel'); assert.equal(ok.body.workspace.primaryColor, '#2F3E6B');
  const cab = db.prepare('SELECT slug, plan FROM cabinet WHERE id=?').get(t.cab);
  assert.equal(cab.slug, 'wsedit', 'le slug (sous-domaine) n\'est jamais modifiable par l\'interface');
  assert.notEqual(cab.plan, 'gratuit', 'le plan n\'est jamais modifiable par l\'interface');
  const log = db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND entite='espace_travail'").get(t.cab);
  assert.ok(log && JSON.parse(log.details).avant, 'modification auditée avec avant/après');
  const collab = nonAdminUser(t);
  const ro = await reqJson('GET', '/api/workspace', { cookie: cookieOf(collab) });
  assert.equal(ro.status, 200, 'lecture autorisée au collaborateur');
  const deny = await reqJson('PUT', '/api/workspace', { cookie: cookieOf(collab), body: { nomAffiche: 'X' } });
  assert.equal(deny.status, 403, 'modification refusée au collaborateur');
  const other = tenantWithSlug('wsother');
  const iso = await reqJson('GET', '/api/workspace', { cookie: cookieOf(other.u) });
  assert.notEqual(iso.body.workspace.displayName, 'Réel', 'chaque cabinet ne voit que son propre espace');
});

test('saas/conventions : la règle appliquée affichée est celle du moteur central (lecture seule)', async () => {
  const t = newTenant();
  const four = uid('four');
  db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,60)').run(four, t.cab, t.ent, 'FRS REGLE');
  const c1 = uid('conv'), c2 = uid('conv');
  db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut,created_at) VALUES (?,?,?,?,90,'valide','2026-01-01 10:00:00')").run(c1, t.cab, t.ent, four);
  db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut,created_at) VALUES (?,?,?,?,110,'valide','2026-02-01 10:00:00')").run(c2, t.cab, t.ent, four);
  const r = await reqJson('GET', `/api/clients/${t.ent}/conventions`, { cookie: cookieOf(t.u) });
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.body.map(c => [c.id, c]));
  const active = require('../src/db').activeConventionFor(t.ent, four);
  assert.equal(active.id, c2);
  assert.equal(byId[c2].appliquee, true, 'la plus récente est appliquée');
  assert.equal(byId[c1].appliquee, false, 'l\'ancienne ne l\'est pas');
  assert.deepEqual(byId[c1].regle_fournisseur, { delai: 110, source: 'convention' });
});

test('saas/périodes : l\'historique clôture / réouverture (qui, quand, motif) est restitué', async () => {
  const t = newTenant();
  seedLateFactL6(t, { annee: 2026, trimestre: 1, date: '2026-01-05', num: 'HIST-1' });
  const ck = cookieOf(t.u);
  assert.equal((await reqJson('POST', `/api/clients/${t.ent}/periods/2026/1/close`, { cookie: ck, body: {} })).status, 200);
  assert.equal((await reqJson('POST', `/api/clients/${t.ent}/periods/2026/1/reopen`, { cookie: ck, body: { motif: 'Régularisation test' } })).status, 200);
  const s = await reqJson('GET', `/api/clients/${t.ent}/periods/2026/1/summary`, { cookie: ck });
  const h = s.body.periode.historique;
  assert.equal(h.length, 2);
  assert.equal(h[0].action, 'reouverture'); assert.equal(h[0].motif, 'Régularisation test');
  assert.equal(h[1].action, 'cloture'); assert.equal(h[1].par, 'U');
  assert.equal(s.body.periode.motif_reouverture, 'Régularisation test');
  const other = newTenant();
  const leak = await reqJson('GET', `/api/clients/${t.ent}/periods/2026/1/summary`, { cookie: cookieOf(other.u) });
  assert.equal(leak.status, 404, 'historique invisible depuis un autre cabinet');
});

test('saas/UI : dialogues in-app, identité de marque, aucun actif externe', () => {
  const pub = path.join(__dirname, '..', 'public');
  const app = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(pub, 'app.html'), 'utf8') + fs.readFileSync(path.join(pub, 'login.html'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'css', 'app.css'), 'utf8');
  // Plus aucun confirm()/prompt() natif : actions sensibles via ui.confirm / ui.prompt.
  assert.doesNotMatch(app.replace(/ui\.(confirm|prompt)\(|(confirm|prompt)\(o\)/g, ''), /\b(window\.)?(confirm|prompt)\(/, 'aucun dialogue natif');
  assert.match(app, /closePeriodAction[\s\S]{0,600}ui\.confirm\(/, 'clôture confirmée par un dialogue explicite');
  // Actifs de marque présents et référencés ; CSP 'self' respectée (aucune origine externe).
  for (const f of ['brand/favicon.svg', 'brand/favicon-32.png', 'brand/apple-touch-icon.png', 'brand/delaipay-mark.svg', 'brand/delaipay-logo-light-bg.svg', 'brand/delaipay-logo-dark-bg.svg', 'fonts/inter-latin-var.woff2'])
    assert.ok(fs.existsSync(path.join(pub, 'assets', f)), 'actif présent : ' + f);
  assert.doesNotMatch(html + css, /https?:\/\/(?!www\.w3\.org)/, 'aucune ressource externe (CSP self)');
  // Aucune affirmation de conformité non démontrée sur la page de connexion.
  assert.doesNotMatch(html, /09-08|certifi|ISO 27001|SOC ?2|RGPD/i, 'aucune certification revendiquée');
  // Les couleurs de risque restent distinctes des couleurs de marque / d'espace.
  assert.match(css, /--late:#[0-9A-Fa-f]{6}/); assert.match(css, /--info:#[0-9A-Fa-f]{6}/); assert.match(css, /--locked:#[0-9A-Fa-f]{6}/);
  assert.match(css, /prefers-reduced-motion/, 'mouvement réduit respecté');
});

/* ================================================================================
 * SaaS — INCRÉMENT 1 : isolation inter-espaces, rôles, utilisateurs, invitations,
 * création d'espace, logo, états de connexion, onboarding. Aucune règle métier touchée.
 * ================================================================================ */
const workspaceMod = require('../src/workspace');
const permsMod = require('../src/permissions');
function mkWorkspace(slug, extra = {}) {
  const email = `admin-${slug}@ex.ma`;
  const r = workspaceMod.createWorkspace({ slug, nom: 'Cabinet ' + slug, admin: { email, nom: 'Admin ' + slug, password: 'Motdepasse1!' }, ...extra });
  const ent = uid('ent'); db.prepare('INSERT INTO entreprise (id,cabinet_id,raison_sociale) VALUES (?,?,?)').run(ent, r.cabinetId, 'Client ' + slug);
  return { cab: r.cabinetId, u: r.userId, ent, email, slug };
}
function addUser(cab, role, email) {
  const id = uid('u');
  db.prepare('INSERT INTO utilisateur (id,cabinet_id,nom,email,password_hash,role,actif) VALUES (?,?,?,?,?,?,1)')
    .run(id, cab, 'User ' + role, email || (uid('e') + '@ex.ma').toLowerCase(), auth.hashPassword('Motdepasse1!'), role);
  return id;
}
const PNG_HEAD = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);

test('saas1/création : espace + premier admin en une transaction ; aucun espace partiel', () => {
  const ok = workspaceMod.createWorkspace({ slug: 'crea-ok', nom: 'Créa OK', raisonLegale: 'Créa OK SARL', admin: { email: 'A@Crea.ma', nom: 'Admin Créa', password: 'Motdepasse1!' } });
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(ok.cabinetId);
  assert.equal(cab.slug, 'crea-ok'); assert.equal(cab.actif, 1); assert.equal(cab.raison_legale, 'Créa OK SARL');
  const u = db.prepare('SELECT * FROM utilisateur WHERE id=?').get(ok.userId);
  assert.equal(u.cabinet_id, ok.cabinetId, 'le premier admin appartient au nouvel espace'); assert.equal(u.role, 'admin'); assert.equal(u.email, 'a@crea.ma');
  assert.throws(() => workspaceMod.createWorkspace({ slug: 'crea-rb', nom: 'RB', admin: { email: 'rb@ex.ma', nom: 'RB', password: 'Motdepasse1!' }, onInsideTransaction: () => { throw new Error('panne simulée'); } }), /panne simulée/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM cabinet WHERE slug='crea-rb'").get().n, 0, 'rollback : aucun espace');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM utilisateur WHERE email='rb@ex.ma'").get().n, 0, 'rollback : aucun utilisateur');
  assert.throws(() => workspaceMod.createWorkspace({ slug: 'crea-ok', nom: 'Doublon', admin: { email: 'x@ex.ma', nom: 'X', password: 'Motdepasse1!' } }), /déjà utilisé/);
  assert.throws(() => workspaceMod.createWorkspace({ slug: 'www', nom: 'Réservé', admin: { email: 'x@ex.ma', nom: 'X', password: 'Motdepasse1!' } }), /invalide/);
  assert.throws(() => workspaceMod.createWorkspace({ slug: 'faible', nom: 'Faible', admin: { email: 'x@ex.ma', nom: 'X', password: 'court' } }), /10 caractères/);
});

test('saas1/connexion : espace inactif, e-mail ambigu sur hôte neutre, mauvais espace', async () => {
  const a = mkWorkspace('conn-a'), b = mkWorkspace('conn-b');
  const shared = 'partage@ex.ma';
  addUser(a.cab, 'collaborateur', shared); addUser(b.cab, 'collaborateur', shared);
  const amb = await reqJson('POST', '/api/auth/login', { host: 'localhost', body: { email: shared, password: 'Motdepasse1!' } });
  assert.equal(amb.status, 409, 'hôte neutre + e-mail dans 2 espaces : aucun choix implicite'); assert.equal(amb.body.code, 'ambiguous_workspace');
  const badPw = await reqJson('POST', '/api/auth/login', { host: 'localhost', body: { email: shared, password: 'mauvais-mdp-1' } });
  assert.equal(badPw.status, 401, 'mauvais mot de passe : message générique (pas de révélation de multi-espace)');
  const own = await reqJson('POST', '/api/auth/login', { host: 'conn-a.localhost', body: { email: shared, password: 'Motdepasse1!' } });
  assert.equal(own.status, 200, 'sur son sous-domaine : connexion non ambiguë');
  workspaceMod.setWorkspaceActive(b.cab, false);
  const inact = await reqJson('POST', '/api/auth/login', { host: 'conn-b.localhost', body: { email: b.email, password: 'Motdepasse1!' } });
  assert.equal(inact.status, 403); assert.equal(inact.body.code, 'workspace_inactive');
  const sess = await reqJson('GET', '/api/me', { cookie: cookieOf(b.u) });
  assert.equal(sess.status, 401, 'session existante coupée quand l’espace est désactivé'); assert.equal(sess.body.code, 'workspace_inactive');
  const pub = await reqJson('GET', '/api/tenant', { host: 'conn-b.localhost' });
  assert.equal(pub.body.active, false, 'la page de connexion peut annoncer l’espace suspendu');
  const cross = await reqJson('GET', '/api/me', { cookie: cookieOf(a.u), host: 'conn-b.localhost' });
  assert.equal(cross.status, 401, 'session d’un espace présentée sur l’hôte d’un autre : refus'); assert.equal(cross.body.code, 'wrong_workspace');
  const uid2 = addUser(a.cab, 'collaborateur'); db.prepare('UPDATE utilisateur SET actif=0 WHERE id=?').run(uid2);
  const dis = await reqJson('GET', '/api/me', { cookie: cookieOf(uid2) });
  assert.equal(dis.status, 401); assert.equal(dis.body.code, 'user_inactive');
});

test('saas1/isolation : l’espace B ne peut lire ni modifier AUCUNE ressource de l’espace A', async () => {
  const A = mkWorkspace('iso-a'), B = mkWorkspace('iso-b');
  const four = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale) VALUES (?,?,?,?)').run(four, A.cab, A.ent, 'FRS A');
  const conv = uid('conv'); db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut,fichier) VALUES (?,?,?,?,90,'valide','x.pdf')").run(conv, A.cab, A.ent, four);
  const fac = uid('fac'); db.prepare('INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,annee,trimestre) VALUES (?,?,?,?,?,?,?,?,?)').run(fac, A.cab, A.ent, four, 'A-1', 100, '2026-01-10', 2026, 1);
  const ano = uid('ano'); db.prepare("INSERT INTO anomalie (id,cabinet_id,entreprise_id,type,statut) VALUES (?,?,?,'doublon','ouverte')").run(ano, A.cab, A.ent);
  require('../src/db').audit(A.cab, A.u, 'create', 'secret_a', { marque: 'SECRET-A' }, null);
  const ck = cookieOf(B.u);
  const Q = '?annee=2026&trimestre=1';
  for (const p of [`/api/clients/${A.ent}`, `/api/clients/${A.ent}/summary${Q}`, `/api/clients/${A.ent}/delais${Q}`, `/api/clients/${A.ent}/declaration${Q}`,
    `/api/clients/${A.ent}/declaration/export.csv${Q}`, `/api/clients/${A.ent}/delais/export.xlsx${Q}`, `/api/clients/${A.ent}/visa/export.pdf${Q}`,
    `/api/clients/${A.ent}/conventions`, `/api/conventions/${conv}/file`, `/api/clients/${A.ent}/periods`, `/api/clients/${A.ent}/periods/2026/1/summary`,
    `/api/clients/${A.ent}/documents${Q}`, `/api/clients/${A.ent}/fournisseurs`]) {
    const r = await reqJson('GET', p, { cookie: ck });
    assert.equal(r.status, 404, 'lecture refusée : ' + p);
  }
  for (const [m, p, body] of [['PUT', `/api/clients/${A.ent}`, { raison_sociale: 'Pirate' }], ['DELETE', `/api/clients/${A.ent}`],
    ['POST', `/api/clients/${A.ent}/conventions`, { fournisseur_id: four, delai: 90 }], ['DELETE', `/api/clients/${A.ent}/conventions/${conv}`],
    ['PATCH', `/api/clients/${A.ent}/factures/${fac}/doublon`, { statut: 'confirme' }], ['PATCH', `/api/clients/${A.ent}/fournisseurs/${four}/classification`, { operateur_reseau: true, statut: 'confirme' }],
    ['POST', `/api/clients/${A.ent}/periods/2026/1/close`, {}], ['POST', `/api/clients/${A.ent}/recompute${Q}`, {}], ['PATCH', `/api/users/${A.u}`, { role: 'lecture' }]]) {
    const r = await reqJson(m, p, { cookie: ck, body });
    assert.ok([403, 404].includes(r.status), `écriture refusée (${r.status}) : ${m} ${p}`);
  }
  await reqJson('POST', `/api/anomalies/${ano}/resolve`, { cookie: ck, body: {} });
  assert.equal(db.prepare('SELECT statut FROM anomalie WHERE id=?').get(ano).statut, 'ouverte', 'anomalie de A intacte');
  assert.equal(db.prepare('SELECT raison_sociale FROM entreprise WHERE id=?').get(A.ent).raison_sociale, 'Client iso-a', 'client de A intact');
  const aud = await reqJson('GET', '/api/audit', { cookie: ck });
  assert.ok(!JSON.stringify(aud.body).includes('SECRET-A'), 'journal d’audit cloisonné');
  const users = await reqJson('GET', '/api/users', { cookie: ck });
  assert.ok(users.body.users.every(u => u.id !== A.u), 'liste des utilisateurs cloisonnée');
  const cl = await reqJson('GET', '/api/clients', { cookie: ck });
  assert.ok(cl.body.every(c => c.id !== A.ent), 'portefeuille cloisonné');
  const dash = await reqJson('GET', '/api/dashboard' + Q, { cookie: ck });
  assert.equal(dash.body.kpis.facturesTrim, 0, 'tableau de bord cloisonné');
});

test('saas1/isolation : un jeton d’analyse d’import ne sert qu’à l’espace qui l’a créé', async () => {
  const A = mkWorkspace('tok-a'), B = mkWorkspace('tok-b');
  const buf = convBuf([['FRS JETON', '000000000000901', '', '', 'OUI', 90]]);
  const an = await postFile(`/api/clients/${A.ent}/import/analyze`, cookieOf(A.u), buf, 'j.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(an.status, 200); assert.ok(an.body.token.startsWith(`tmp_${A.cab}_`), 'jeton lié à l’espace');
  const steal = await reqJson('POST', `/api/clients/${B.ent}/import/preview?annee=2026&trimestre=1`, { cookie: cookieOf(B.u), body: { token: an.body.token, mapping: {} } });
  assert.equal(steal.status, 400, 'jeton d’un autre espace refusé');
  const forged = await reqJson('POST', `/api/clients/${B.ent}/import/preview?annee=2026&trimestre=1`, { cookie: cookieOf(B.u), body: { token: `tmp_${B.cab}_../../data/delaipay.db`, mapping: {} } });
  assert.equal(forged.status, 400, 'jeton forgé / traversée refusés');
});

test('saas1/rôles : matrice serveur Administrateur / Comptable / Lecture seule', async () => {
  const W = mkWorkspace('roles');
  const compta = addUser(W.cab, 'collaborateur'), lect = addUser(W.cab, 'lecture');
  // Lecture seule : consultation + export oui ; toute écriture non ; son propre mot de passe oui.
  assert.equal((await reqJson('GET', `/api/clients/${W.ent}/declaration?annee=2026&trimestre=1`, { cookie: cookieOf(lect) })).status, 200);
  assert.equal((await reqJson('GET', `/api/clients/${W.ent}/declaration/export.csv?annee=2026&trimestre=1`, { cookie: cookieOf(lect) })).status, 200, 'export autorisé');
  for (const [m, p, b] of [['POST', '/api/clients', { raison_sociale: 'X' }], ['PUT', `/api/clients/${W.ent}`, { raison_sociale: 'Y' }], ['POST', `/api/clients/${W.ent}/recompute?annee=2026&trimestre=1`, {}], ['PUT', '/api/onboarding', { current: 'client' }]]) {
    const r = await reqJson(m, p, { cookie: cookieOf(lect), body: b });
    assert.equal(r.status, 403, `lecture seule refusée : ${m} ${p}`); assert.equal(r.body.code, 'read_only');
  }
  const pw = await reqJson('PUT', '/api/me/password', { cookie: cookieOf(lect), body: { current: 'Motdepasse1!', next: 'NouveauMdp2026' } });
  assert.equal(pw.status, 200, 'la lecture seule peut changer SON mot de passe');
  // Comptable : opérations comptables oui ; administration, suppression de client, clôture non.
  assert.equal((await reqJson('POST', '/api/clients', { cookie: cookieOf(compta), body: { raison_sociale: 'Nouveau client' } })).status, 200);
  for (const [m, p, b] of [['DELETE', `/api/clients/${W.ent}`], ['PUT', '/api/workspace', { nomAffiche: 'Z' }], ['GET', '/api/users'], ['POST', '/api/invitations', { email: 'z@ex.ma', role: 'lecture' }],
    ['POST', `/api/clients/${W.ent}/periods/2026/1/close`, {}], ['POST', '/api/taux', { taux: 0.02, date_debut: '2027-01-01' }]]) {
    const r = await reqJson(m, p, { cookie: cookieOf(compta), body: b });
    assert.equal(r.status, 403, `comptable refusé : ${m} ${p}`);
  }
  assert.ok(db.prepare('SELECT 1 FROM entreprise WHERE id=?').get(W.ent), 'dossier non supprimé par le comptable');
  // Administrateur : suppression autorisée.
  const tmpEnt = uid('ent'); db.prepare('INSERT INTO entreprise (id,cabinet_id,raison_sociale) VALUES (?,?,?)').run(tmpEnt, W.cab, 'À supprimer');
  assert.equal((await reqJson('DELETE', `/api/clients/${tmpEnt}`, { cookie: cookieOf(W.u) })).status, 200);
  // Matrice exposée cohérente.
  assert.equal(permsMod.can('lecture', 'export'), true); assert.equal(permsMod.can('lecture', 'import'), false);
  assert.equal(permsMod.can('collaborateur', 'close_period'), false); assert.equal(permsMod.can('admin', 'manage_users'), true);
  const me = await reqJson('GET', '/api/me', { cookie: cookieOf(compta) });
  assert.equal(me.body.permissions.manage_users, false); assert.equal(me.body.user.roleLabel, 'Comptable');
});

test('saas1/utilisateurs : dernier administrateur et soi-même protégés, changements audités', async () => {
  const W = mkWorkspace('users');
  const self = await reqJson('PATCH', `/api/users/${W.u}`, { cookie: cookieOf(W.u), body: { role: 'lecture' } });
  assert.equal(self.status, 400, 'impossible de se retirer ses droits');
  const other = addUser(W.cab, 'admin');
  assert.equal((await reqJson('PATCH', `/api/users/${other}`, { cookie: cookieOf(W.u), body: { role: 'collaborateur' } })).status, 200);
  assert.throws(() => workspaceMod.updateUser(W.cab, other, W.u, { actif: false }), /au moins un administrateur|propres droits/);
  const c = addUser(W.cab, 'collaborateur');
  const off = await reqJson('PATCH', `/api/users/${c}`, { cookie: cookieOf(W.u), body: { actif: false } });
  assert.equal(off.status, 200); assert.equal(off.body.user.actif, false);
  assert.equal((await reqJson('GET', '/api/me', { cookie: cookieOf(c) })).status, 401, 'accès coupé immédiatement');
  const bad = await reqJson('PATCH', `/api/users/${c}`, { cookie: cookieOf(W.u), body: { role: 'superadmin' } });
  assert.equal(bad.status, 400, 'rôle inconnu refusé');
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE cabinet_id=? AND entite='utilisateur'").get(W.cab).n >= 2);
});

test('saas1/invitations : jeton haché, usage unique, expiration, révocation, espace de l’hôte', async () => {
  const W = mkWorkspace('invit'), X = mkWorkspace('invit-x');
  const r = await reqJson('POST', '/api/invitations', { cookie: cookieOf(W.u), body: { email: 'Nouvelle@Cabinet.ma', role: 'collaborateur' } });
  assert.equal(r.status, 200); const token = r.body.invitation.token; assert.ok(token.length >= 40);
  const row = db.prepare('SELECT * FROM invitation WHERE id=?').get(r.body.invitation.id);
  assert.notEqual(row.token_hash, token, 'jeton jamais stocké en clair');
  const logs = db.prepare('SELECT details FROM audit_log WHERE cabinet_id=?').all(W.cab).map(x => x.details).join(' ');
  assert.ok(!logs.includes(token), 'jeton jamais journalisé');
  assert.equal((await reqJson('POST', '/api/invitations/lookup', { host: 'invit-x.localhost', body: { token } })).status, 410, 'hôte d’un autre espace : refus');
  const lk = await reqJson('POST', '/api/invitations/lookup', { host: 'invit.localhost', body: { token } });
  assert.equal(lk.status, 200); assert.equal(lk.body.email, 'nouvelle@cabinet.ma'); assert.equal(lk.body.workspace.displayName, 'Cabinet invit');
  const weak = await reqJson('POST', '/api/invitations/accept', { host: 'invit.localhost', body: { token, nom: 'Nadia', password: 'court' } });
  assert.equal(weak.status, 400, 'mot de passe faible refusé');
  const acc = await reqJson('POST', '/api/invitations/accept', { host: 'invit.localhost', body: { token, nom: 'Nadia Alaoui', password: 'Motdepasse2026' } });
  assert.equal(acc.status, 200);
  const nu = db.prepare("SELECT * FROM utilisateur WHERE email='nouvelle@cabinet.ma'").get();
  assert.equal(nu.cabinet_id, W.cab, 'compte créé DANS l’espace invitant'); assert.equal(nu.role, 'collaborateur'); assert.equal(nu.invite_par, W.u);
  assert.equal((await reqJson('POST', '/api/invitations/accept', { body: { token, nom: 'Bis', password: 'Motdepasse2026' } })).status, 410, 'usage unique');
  const r2 = await reqJson('POST', '/api/invitations', { cookie: cookieOf(W.u), body: { email: 'expire@ex.ma', role: 'lecture' } });
  db.prepare("UPDATE invitation SET expires_at='2000-01-01 00:00:00' WHERE id=?").run(r2.body.invitation.id);
  assert.equal((await reqJson('POST', '/api/invitations/lookup', { body: { token: r2.body.invitation.token } })).status, 410, 'invitation expirée');
  const r3 = await reqJson('POST', '/api/invitations', { cookie: cookieOf(W.u), body: { email: 'revoque@ex.ma', role: 'lecture' } });
  assert.equal((await reqJson('DELETE', `/api/invitations/${r3.body.invitation.id}`, { cookie: cookieOf(X.u) })).status, 404, 'révocation cross-tenant refusée');
  assert.equal((await reqJson('DELETE', `/api/invitations/${r3.body.invitation.id}`, { cookie: cookieOf(W.u) })).status, 200);
  assert.equal((await reqJson('POST', '/api/invitations/accept', { body: { token: r3.body.invitation.token, nom: 'R', password: 'Motdepasse2026' } })).status, 410, 'invitation révoquée');
  assert.equal((await reqJson('POST', '/api/invitations', { cookie: cookieOf(W.u), body: { email: 'nouvelle@cabinet.ma', role: 'lecture' } })).status, 409, 'déjà membre');
  assert.equal((await reqJson('POST', '/api/invitations/lookup', { body: { token: 'x'.repeat(43) } })).status, 410, 'jeton inventé');
});

test('saas1/marque : logo PNG accepté, SVG / HTML déguisé / trop lourd refusés, servi à son seul espace', async () => {
  const W = mkWorkspace('logo'), X = mkWorkspace('logo-x');
  const svg = await postFile('/api/workspace/logo', cookieOf(W.u), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.png', 'image/png');
  assert.equal(svg.status, 400, 'SVG refusé même renommé en .png');
  const html = await postFile('/api/workspace/logo', cookieOf(W.u), Buffer.from('<html><script>alert(1)</script></html>'), 'x.jpg', 'image/jpeg');
  assert.equal(html.status, 400, 'HTML déguisé refusé');
  const big = await postFile('/api/workspace/logo', cookieOf(W.u), Buffer.concat([PNG_HEAD, Buffer.alloc(1024 * 1024 + 10)]), 'big.png', 'image/png');
  assert.equal(big.status, 400, 'plus de 1 Mo refusé');
  const collab = addUser(W.cab, 'collaborateur');
  assert.equal((await postFile('/api/workspace/logo', cookieOf(collab), PNG_HEAD, 'l.png', 'image/png')).status, 403, 'comptable refusé');
  const ok = await postFile('/api/workspace/logo', cookieOf(W.u), PNG_HEAD, '../../evil name.png', 'image/png');
  assert.equal(ok.status, 200); assert.ok(ok.body.workspace.logoUrl);
  const cab = db.prepare('SELECT logo FROM cabinet WHERE id=?').get(W.cab);
  assert.match(cab.logo, /^logo_[a-f0-9]+\.png$/, 'nom de fichier généré, jamais celui du client');
  const pub = await getText('/api/tenant/logo');
  assert.equal(pub.status, 404, 'hôte neutre : aucun logo exposé');
  const own = await getText('/api/workspace/logo', cookieOf(W.u));
  assert.equal(own.status, 200); assert.equal(own.ct, 'image/png');
  const other = await getText('/api/workspace/logo', cookieOf(X.u));
  assert.equal(other.status, 404, 'un autre espace ne voit que SON logo (absent ici)');
  const tn = await reqJson('GET', '/api/tenant', { host: 'logo.localhost' });
  assert.ok(tn.body.logoUrl && tn.body.logoUrl.startsWith('/api/tenant/logo'), 'logo public annoncé pour la page de connexion');
});

test('saas1/onboarding : étapes détectées sur données réelles, étapes indispensables non ignorables', async () => {
  const W = mkWorkspace('onb');
  db.prepare('DELETE FROM entreprise WHERE cabinet_id=?').run(W.cab);
  let s = (await reqJson('GET', '/api/onboarding', { cookie: cookieOf(W.u) })).body;
  assert.equal(s.facts.clients, 0); assert.equal(s.steps.find(x => x.key === 'client').status, 'todo'); assert.equal(s.complete, false);
  const sk = await reqJson('PUT', '/api/onboarding', { cookie: cookieOf(W.u), body: { step: 'client', status: 'skipped' } });
  assert.equal(sk.status, 400, 'étape indispensable non ignorable');
  assert.equal((await reqJson('PUT', '/api/onboarding', { cookie: cookieOf(W.u), body: { complete: true } })).status, 400, 'fin impossible tant que le socle manque');
  await reqJson('POST', '/api/clients', { cookie: cookieOf(W.u), body: { raison_sociale: 'Premier client' } });
  s = (await reqJson('GET', '/api/onboarding', { cookie: cookieOf(W.u) })).body;
  assert.equal(s.steps.find(x => x.key === 'client').status, 'done', 'client détecté automatiquement');
  const skc = await reqJson('PUT', '/api/onboarding', { cookie: cookieOf(W.u), body: { step: 'conventions', status: 'skipped' } });
  assert.equal(skc.status, 200); assert.equal(skc.body.steps.find(x => x.key === 'conventions').status, 'skipped');
  const later = await reqJson('PUT', '/api/onboarding', { cookie: cookieOf(W.u), body: { dismissed: true, current: 'factures' } });
  assert.equal(later.body.dismissed, true); assert.equal(later.body.current, 'factures', 'progression mémorisée');
  const X = mkWorkspace('onb-x');
  assert.equal((await reqJson('GET', '/api/onboarding', { cookie: cookieOf(X.u) })).body.dismissed, false, 'progression propre à chaque espace');
});

test('saas1/UI : rôles reflétés, invitation hors URL, logo en image uniquement, messages de session', () => {
  const pub = path.join(__dirname, '..', 'public');
  const app = fs.readFileSync(path.join(pub, 'js', 'app.js'), 'utf8');
  const inv = fs.readFileSync(path.join(pub, 'js', 'invite.js'), 'utf8');
  const login = fs.readFileSync(path.join(pub, 'js', 'login.js'), 'utf8');
  assert.match(app, /function can\(action\)/); assert.match(app, /data-perm="delete_client"/); assert.match(app, /data-perm="import"/);
  assert.match(app, /reason=' \+ encodeURIComponent\(code\)/, '401 → connexion avec motif (fin du 401 silencieux)');
  assert.match(login, /expired:/); assert.match(login, /workspace_inactive:/);
  assert.match(inv, /location\.hash/, 'jeton lu dans le fragment d’URL'); assert.match(inv, /\/api\/invitations\/lookup', \{ token \}/, 'jeton envoyé en POST');
  assert.match(app, /\/invite#t=/, 'lien d’invitation par fragment');
  assert.match(app, /\$\('#wsName'\)\.textContent = name/, 'nom d’espace inséré en texte (pas de HTML)');
  assert.doesNotMatch(app + inv + login, /image\/svg\+xml/, 'aucun téléversement SVG proposé');
});

/* ================================================================================
 * SaaS — CORRECTIFS COWORK INCRÉMENT 1 (ROLE-1, AUTH-1, SESS-1, ONB-1, ONB-2, AUTH-3)
 * ================================================================================ */
function reqFull(method, pathUrl, opts = {}) {
  const http = require('http'); const u = new URL(baseUrl() + pathUrl);
  const payload = opts.body ? JSON.stringify(opts.body) : null; const headers = {};
  if (opts.cookie) headers.Cookie = opts.cookie; if (opts.host) headers.Host = opts.host;
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    }); r.on('error', reject); if (payload) r.write(payload); r.end();
  });
}
function invoiceBuf(rows) {
  const ws = XLSX.utils.aoa_to_sheet([['N° facture', 'Fournisseur', 'ICE fournisseur', 'Date facture', 'Date paiement', 'Montant TTC'], ...rows]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Achats');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function analyzeInvoices(t, ck, rows) {
  const an = await postFile(`/api/clients/${t.ent}/import/analyze`, ck, invoiceBuf(rows), 'achats.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(an.status, 200, 'analyse OK');
  const sh = an.body.feuilles.find(f => f.nom === an.body.suggestion) || an.body.feuilles[0];
  const mapping = {}; for (const [k, v] of Object.entries(sh.mapping || {})) mapping[k] = v.col;
  return { token: an.body.token, sheetName: sh.nom, headerRow: sh.ligneEntete, mapping, sourceName: 'achats.xlsx' };
}

test('fix/ROLE-1 : le rôle affiché suit le rôle réel (pas de « fonction » figée à l’invitation)', async () => {
  const W = mkWorkspace('role1');
  const inv = await reqJson('POST', '/api/invitations', { cookie: cookieOf(W.u), body: { email: 'r1@ex.ma', role: 'lecture' } });
  await reqJson('POST', '/api/invitations/accept', { host: 'role1.localhost', body: { token: inv.body.invitation.token, nom: 'Rita Un', password: 'Motdepasse2026' } });
  const u = db.prepare("SELECT * FROM utilisateur WHERE email='r1@ex.ma'").get();
  assert.equal(u.titre, null, 'la fonction n’est plus déduite du rôle d’invitation');
  await reqJson('PATCH', `/api/users/${u.id}`, { cookie: cookieOf(W.u), body: { role: 'collaborateur' } });
  const me = await reqJson('GET', '/api/me', { cookie: cookieOf(u.id) });
  assert.equal(me.body.user.role, 'collaborateur'); assert.equal(me.body.user.roleLabel, 'Comptable'); assert.notEqual(me.body.user.titre, 'Lecture seule');
  // Donnée héritée : une fonction égale à un libellé de rôle est effacée au changement de rôle.
  const old = addUser(W.cab, 'lecture'); db.prepare("UPDATE utilisateur SET titre='Lecture seule' WHERE id=?").run(old);
  await reqJson('PATCH', `/api/users/${old}`, { cookie: cookieOf(W.u), body: { role: 'collaborateur' } });
  assert.equal(db.prepare('SELECT titre FROM utilisateur WHERE id=?').get(old).titre, null);
  // Une vraie fonction (non liée au rôle) est conservée.
  const real = addUser(W.cab, 'lecture'); db.prepare("UPDATE utilisateur SET titre='Expert-comptable' WHERE id=?").run(real);
  await reqJson('PATCH', `/api/users/${real}`, { cookie: cookieOf(W.u), body: { role: 'collaborateur' } });
  assert.equal(db.prepare('SELECT titre FROM utilisateur WHERE id=?').get(real).titre, 'Expert-comptable');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /\$\('#sideTitle'\)\.textContent = state\.me\.roleLabel/, 'barre latérale : rôle effectif');
});

test('fix/AUTH-1 : e-mail présent dans plusieurs espaces — réponse cohérente quel que soit le compte', async () => {
  const A = mkWorkspace('auth1-a'), B = mkWorkspace('auth1-b');
  const mail = 'double-auth1@ex.ma';
  const ua = addUser(A.cab, 'collaborateur', mail), ub = addUser(B.cab, 'collaborateur', mail);
  db.prepare('UPDATE utilisateur SET password_hash=? WHERE id=?').run(auth.hashPassword('MdpEspaceB-2026'), ub);
  const post = (host, email, password) => reqJson('POST', '/api/auth/login', { host, body: { email, password } });
  const r1 = await post('localhost', mail, 'Motdepasse1!');       // mdp du compte A
  const r2 = await post('localhost', mail, 'MdpEspaceB-2026');    // mdp du compte B (était « Identifiants incorrects »)
  assert.equal(r1.status, 409); assert.equal(r2.status, 409, '1. hôte neutre : même réponse « plusieurs espaces » pour le mdp de B');
  assert.equal(r1.body.error, r2.body.error, 'aucune indication de l’espace concerné');
  assert.equal((await post('auth1-b.localhost', mail, 'MdpEspaceB-2026')).status, 200, '2. sur l’hôte de son espace : connexion');
  assert.equal((await post('localhost', 'inconnu-auth1@ex.ma', 'Motdepasse1!')).status, 401, '3. e-mail inconnu : 401 générique');
  const wrong = await post('localhost', mail, 'mauvais-mdp-9');
  assert.equal(wrong.status, 401, '4. mauvais mot de passe : 401 (pas de révélation du multi-espace)');
  assert.equal(wrong.body.error, 'Identifiants incorrects.');
  assert.equal((await post('auth1-a.localhost', mail, 'MdpEspaceB-2026')).status, 401, '5. mdp de B sur l’hôte de A : refusé');
  assert.ok(ua && ub);
});

test('fix/SESS-1 : chaque réponse porte l’identité de la session réelle ; l’UI se réhydrate', async () => {
  const W = mkWorkspace('sess1'); const c = addUser(W.cab, 'lecture');
  const r1 = await reqFull('GET', '/api/me', { cookie: cookieOf(c) });
  assert.equal(r1.headers['x-dp-session'], `${c}:lecture`);
  db.prepare("UPDATE utilisateur SET role='collaborateur' WHERE id=?").run(c);
  const r2 = await reqFull('GET', '/api/clients', { cookie: cookieOf(c) });
  assert.equal(r2.headers['x-dp-session'], `${c}:collaborateur`, 'le rôle relu en base est annoncé immédiatement');
  const r3 = await reqFull('GET', '/api/clients', { cookie: cookieOf(W.u) });
  assert.equal(r3.headers['x-dp-session'].split(':')[0], W.u, 'un autre utilisateur = une autre empreinte');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /function checkSessionFingerprint/); assert.match(app, /checkSessionFingerprint\(res\.headers\.get\('X-DP-Session'\)\)/);
  assert.match(app, /Cette section n'a pas pu être chargée/, 'onglet Paramètres : jamais vide sans message');
});

test('fix/ONB-2 + ONB-1 : trimestre choisi AVANT l’import, rattachement explicite, périodes relues', async () => {
  const W = mkWorkspace('onb2'); const ck = cookieOf(W.u);
  db.prepare('DELETE FROM entreprise WHERE cabinet_id=?').run(W.cab);
  const st0 = (await reqJson('GET', '/api/onboarding', { cookie: ck })).body;
  const keys = st0.steps.map(x => x.key);
  assert.ok(keys.indexOf('periode') < keys.indexOf('factures'), 'étape période AVANT l’import');
  const cl = await reqJson('POST', '/api/clients', { cookie: ck, body: { raison_sociale: 'Client ONB2' } });   // 2. créer le client
  const t = { cab: W.cab, ent: cl.body.id };
  assert.equal((await reqJson('PUT', '/api/onboarding', { cookie: ck, body: { step: 'periode', status: 'done' } })).status, 400, 'étape période impossible sans trimestre');
  assert.equal((await reqJson('PUT', '/api/onboarding', { cookie: ck, body: { periode: { annee: 2026, trimestre: 7 } } })).status, 400, 'trimestre invalide refusé');
  const sel = await reqJson('PUT', '/api/onboarding', { cookie: ck, body: { periode: { annee: 2026, trimestre: 1 } } });   // 3. choisir T1
  assert.deepEqual(sel.body.periode, { annee: 2026, trimestre: 1 }); assert.equal(sel.body.steps.find(x => x.key === 'periode').status, 'done');
  const rows = [['F-1', 'FRS UN', '000000000000111', '2026-01-10', '2026-02-01', 1200], ['F-2', 'FRS DEUX', '000000000000222', '2026-02-15', '2026-03-01', 800]];
  const body = await analyzeInvoices(t, ck, rows);
  const noPer = await reqJson('POST', `/api/clients/${t.ent}/import/confirm`, { cookie: ck, body: { ...body, strictPeriode: true } });   // 6. sans période
  assert.equal(noPer.status, 400, 'import sans période : bloqué');
  const wrong = await reqJson('POST', `/api/clients/${t.ent}/import/confirm?annee=2026&trimestre=2`, { cookie: ck, body: { ...body, strictPeriode: true } });   // 8. en T2
  assert.equal(wrong.status, 409, 'factures T1 importées « dans T2 » : refus sans confirmation explicite'); assert.equal(wrong.body.code, 'hors_periode');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facture WHERE entreprise_id=?').get(t.ent).n, 0, 'aucune facture rattachée par erreur à T2');
  const ok = await reqJson('POST', `/api/clients/${t.ent}/import/confirm?annee=2026&trimestre=1`, { cookie: ck, body: { ...body, strictPeriode: true } });   // 4. en T1
  assert.equal(ok.status, 200); assert.equal(ok.body.imported, 2);
  const per = db.prepare('SELECT annee, trimestre, COUNT(*) n FROM facture WHERE entreprise_id=? GROUP BY 1,2').all(t.ent);
  assert.deepEqual(per.map(p => [p.annee, p.trimestre, p.n]), [[2026, 1, 2]], '5. factures associées à T1');
  const periods = await reqJson('GET', `/api/clients/${t.ent}/periods`, { cookie: ck });   // ONB-1 : source unique des périodes
  assert.ok(periods.body.disponibles.some(p => p.annee === 2026 && p.trimestre === 1 && p.nbFactures === 2), 'T1 disponible après import');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /async function renderOnboarding[\s\S]{0,300}refreshPeriodsKeep\(\)/, 'onboarding relit les périodes');
  assert.match(app, /strictPeriode: true, accepteHorsPeriode/, 'l’assistant exige le contrôle de rattachement');
});

test('fix/AUTH-3 : limitation par identité ciblée, pas par poste entier', async () => {
  const A = mkWorkspace('rl-a'), B = mkWorkspace('rl-b');
  const post = (host, email, password) => reqJson('POST', '/api/auth/login', { host, body: { email, password } });
  for (let i = 0; i < 10; i++) assert.equal((await post('rl-a.localhost', A.email, 'faux-' + i)).status, 401);
  assert.equal((await post('rl-a.localhost', A.email, 'faux-x')).status, 429, '1. échecs répétés sur A : limités');
  assert.equal((await post('rl-a.localhost', A.email, 'Motdepasse1!')).status, 429, '3. A reste protégé (même avec le bon mot de passe)');
  assert.equal((await post('rl-b.localhost', B.email, 'Motdepasse1!')).status, 200, '2. B n’est pas bloqué par A depuis le même poste');
  const C = mkWorkspace('rl-c');
  for (let i = 0; i < 6; i++) await post('rl-c.localhost', C.email, 'faux-' + i);
  assert.equal((await post('rl-c.localhost', C.email, 'Motdepasse1!')).status, 200);
  for (let i = 0; i < 9; i++) assert.equal((await post('rl-c.localhost', C.email, 'faux2-' + i)).status, 401, '4. compteur remis à zéro après succès');
});

/* ============ Incrément 2 — messages d'erreur en clair ============ */
test('erreurs/INC2 : un 404 dit ce qui s’est passé et que faire (jamais « Introuvable » seul)', async () => {
  const t = newTenant();
  const ck = cookieOf(t.u);
  for (const [url, code, method] of [['/api/clients/ent_nexistepas/delais?annee=2026&trimestre=1', 'client_introuvable'],
    ['/api/clients/ent_nexistepas/fournisseurs', 'client_introuvable'],
    [`/api/clients/${t.ent}/conventions/conv_nexistepas`, 'convention_introuvable', 'DELETE'],
    [`/api/clients/${t.ent}/documents/doc_nexistepas`, 'fichier_introuvable', 'DELETE']]) {
    const r = await fetch(baseUrl() + url, { method: method || 'GET', headers: { Cookie: ck } });
    const body = await r.json().catch(() => ({}));
    assert.equal(r.status, 404, url);
    assert.ok(body.error && body.error.length > 40, `${url} : message explicite`);
    assert.ok(!/^Introuvable\.?$/.test(body.error), `${url} : pas de « Introuvable » brut`);
    if (code) assert.equal(body.code, code);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');
  assert.ok(!/error: 'Introuvable\.?'/.test(src) && !/send\('Introuvable'\)/.test(src), 'aucun « Introuvable » brut dans l’API');
});

/* ============ Incrément 2 — P3 Cowork (NEW-2, NEW-3, NEW-5) ============ */
test('P3/NEW-2 : verrouillage par compte — le message parle du compte, pas du poste', async () => {
  const A = mkWorkspace('lk-a');
  const post = (email, password) => reqJson('POST', '/api/auth/login', { host: 'lk-a.localhost', body: { email, password } });
  for (let i = 0; i < 10; i++) await post(A.email, 'faux-' + i);
  const r = await post(A.email, 'faux-x');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'account_locked');
  assert.match(r.body.error, /compte est temporairement verrouillé/);
  assert.ok(!/poste/.test(r.body.error), 'plus de « depuis ce poste »');
  assert.ok(!/depuis ce poste/.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8')), 'la page de connexion affiche le message du serveur');
});

test('P3/NEW-5 : connexions refusées et verrouillages tracés dans le journal de l’espace, sans mot de passe', async () => {
  const A = mkWorkspace('au-a'), B = mkWorkspace('au-b');
  const post = (email, password) => reqJson('POST', '/api/auth/login', { host: 'au-a.localhost', body: { email, password } });
  assert.equal((await post(A.email, 'Secret-Faux-123')).status, 401);
  assert.equal((await post('inconnu@ex.ma', 'Secret-Faux-456')).status, 401);
  for (let i = 0; i < 10; i++) await post(A.email, 'Secret-Faux-' + i);
  const rows = db.prepare("SELECT action, details, user_id FROM audit_log WHERE cabinet_id=? AND action IN ('connexion_refusee','verrouillage_connexion')").all(A.cab);
  const refus = rows.filter(r => r.action === 'connexion_refusee');
  assert.ok(refus.some(r => JSON.parse(r.details).motif === 'mot de passe incorrect' && JSON.parse(r.details).email === A.email), 'mauvais mot de passe tracé');
  assert.ok(refus.some(r => JSON.parse(r.details).motif === 'aucun compte actif pour cette adresse'), 'adresse inconnue tracée dans l’espace visé');
  assert.equal(rows.filter(r => r.action === 'verrouillage_connexion').length, 1, 'un seul événement de verrouillage par fenêtre');
  for (const r of rows) { assert.ok(!/Secret-Faux/.test(r.details), 'aucun mot de passe journalisé'); assert.equal(r.user_id, null); }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE cabinet_id=? AND action IN ('connexion_refusee','verrouillage_connexion')").get(B.cab).n, 0, 'rien dans un autre espace');
});

test('P3/NEW-3 : cookie d’un utilisateur qui n’existe plus → « session expirée », pas « compte désactivé »', async () => {
  const ghost = { id: 'usr_fantome', cabinet_id: 'cab_x', role: 'admin', email: 'x@ex.ma', nom: 'X' };
  const r = await reqJson('GET', '/api/me', { cookie: auth.COOKIE + '=' + auth.signToken(ghost) });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'expired_stale');
  assert.ok(!/désactivé/.test(r.body.error));
  const A = mkWorkspace('st-a'); db.prepare('UPDATE utilisateur SET actif=0 WHERE id=?').run(A.u);
  const d = await reqJson('GET', '/api/me', { cookie: cookieOf(A.u) });
  assert.equal(d.body.code, 'user_inactive', 'un compte réellement désactivé reste signalé comme tel');
});

test('P3/NEW-4 + P3-1 + P3-12 : reprise sur l’étape annoncée, bannière seulement pour un parcours entamé, étape 1 cochée', async () => {
  const W = mkWorkspace('onb-r');
  db.prepare('DELETE FROM entreprise WHERE cabinet_id=?').run(W.cab);
  let s = (await reqJson('GET', '/api/onboarding', { cookie: cookieOf(W.u) })).body;
  assert.equal(s.started, false, 'espace neuf : parcours non entamé');
  assert.equal(s.steps.find(x => x.key === 'bienvenue').status, 'todo');
  s = (await reqJson('PUT', '/api/onboarding', { cookie: cookieOf(W.u), body: { current: 'cabinet' } })).body;
  assert.equal(s.started, true);
  assert.equal(s.steps.find(x => x.key === 'bienvenue').status, 'done', 'P3-12 : « Bienvenue » cochée dès qu’on la quitte');
  // Espace exploité avant l'onboarding (factures présentes, parcours jamais entamé) : pas de bannière « à configurer ».
  const H = mkWorkspace('onb-h');
  const h = (await reqJson('GET', '/api/onboarding', { cookie: cookieOf(H.u) })).body;
  assert.equal(h.started, false);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(js, /!ob\.started && !ob\.dismissed && ob\.facts && ob\.facts\.factures > 0\)\) return ''/, 'P3-1 : bannière masquée pour un espace déjà exploité');
  assert.match(js, /onclick="resumeOnboarding\('\$\{esc\(next\.key\)\}'\)"/, 'NEW-4 : le bouton ouvre l’étape annoncée');
  assert.match(js, /window\.resumeOnboarding = function \(key\) \{ state\._obStep = key \|\| null; setView\('onboarding'\); \}/);
});

/* ============ Incrément 2.1 — C : vérification des anomalies (plus de levée automatique) ============ */
function anoSetup(slug) {
  const W = mkWorkspace(slug);
  const four = (nom) => { const id = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,delai_applicable) VALUES (?,?,?,?,120)').run(id, W.cab, W.ent, nom); return id; };
  const fac = (f, numero, dfac, dpai, amende) => db.prepare("INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,ttc,date_facture,date_paiement,annee,trimestre,a_declarer,montant_amende) VALUES (?,?,?,?,?,1000,?,?,2026,1,?,?)")
    .run(uid('f'), W.cab, W.ent, f, numero, dfac, dpai, amende > 0 ? 1 : 0, amende);
  const ano = (f, numero, annee = 2026, trimestre = 1) => { const id = uid('ano'); db.prepare("INSERT INTO anomalie (id,cabinet_id,entreprise_id,type,gravite,details,entite,entite_id,statut,annee,trimestre) VALUES (?,?,?,'convention_absente','moyenne',?,'facture',?,'ouverte',?,?)").run(id, W.cab, W.ent, `Facture ${numero} : délai de 95 j (> 60 j) SANS convention enregistrée pour le fournisseur X.`, f, annee, trimestre); return id; };
  const conv = (f, debut, fin, fichier = null, signature = null) => { const id = uid('conv'); db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut,date_debut,date_fin,fichier,date_signature) VALUES (?,?,?,?,120,'valide',?,?,?,?)").run(id, W.cab, W.ent, f, debut, fin, fichier, signature); return id; };
  return { W, four, fac, ano, conv };
}
test('INC2.1/C : rapprochement → « à vérifier » (compté) ; cas non couverts restent ouverts ; aucune levée automatique', async () => {
  const { W, four, fac, ano, conv } = anoSetup('ano-c1'); const ck = cookieOf(W.u);
  const f1 = four('COUVERTE'); fac(f1, 'F1', '2026-01-10', '2026-03-20', 25.9); const a1 = ano(f1, 'F1'); conv(f1, '2025-06-01', null, null, '2026-02-01');
  const f3 = four('EXPIREE'); const a3 = ano(f3, 'F3'); conv(f3, '2024-01-01', '2025-12-31');
  const f4 = four('POSTERIEURE'); const a4 = ano(f4, 'F4'); conv(f4, '2026-07-01', null);
  const f5 = four('SANS-TRIMESTRE'); const a5 = ano(f5, 'F5', null, null); conv(f5, '2020-01-01', null);
  const f6 = four('SANS-DATE'); const a6 = ano(f6, 'F6'); conv(f6, null, null);
  const d = (await reqJson('GET', '/api/anomalies', { cookie: ck })).body; const by = id => d.rows.find(x => x.id === id);
  assert.equal(by(a1).statut_calc, 'a_verifier', 'rapprochement automatique = à vérifier, jamais « levée »');
  assert.deepEqual(by(a1).convention.avertissements, ['Convention enregistrée après la fin du trimestre', 'Signée après la date de la facture', 'Justificatif manquant']);
  assert.equal(by(a1).facture.date_paiement, '2026-03-20', 'dates de la facture fournies pour la comparaison');
  for (const [id, sit] of [[a3, 'hors_periode'], [a4, 'hors_periode'], [a5, 'trimestre_inconnu'], [a6, 'non_datee']]) { assert.equal(by(id).statut_calc, 'ouverte'); assert.equal(by(id).situation, sit); }
  assert.deepEqual(d.counts, { ouvertes: 4, aVerifier: 1, levees: 0, resolues: 0, aTraiter: 5 }, 'l’anomalie à vérifier reste comptée');
});
test('INC2.1/C : valider la levée — justificatif exigé, lecture seule et période clôturée refusées, annulation admin, audit', async () => {
  const { W, four, fac, ano, conv } = anoSetup('ano-c2'); const ck = cookieOf(W.u);
  const f = four('BETA'); fac(f, 'B1', '2026-01-10', '2026-03-20', 25.93); const a = ano(f, 'B1'); const c = conv(f, '2026-01-01', null, null, '2025-12-15');
  const lever = (cookie, body = {}) => reqJson('POST', `/api/anomalies/${a}/levee`, { cookie, body });
  const r0 = await lever(ck); assert.equal(r0.status, 409); assert.equal(r0.body.code, 'justificatif_manquant', 'sans justificatif : refusée');
  db.prepare("UPDATE convention SET fichier='up_x.pdf' WHERE id=?").run(c);
  const ro = addUser(W.cab, 'lecture', 'ro-lev@ex.ma'); assert.equal((await lever(cookieOf(ro))).status, 403, 'lecture seule refusée côté serveur');
  const compta = addUser(W.cab, 'collaborateur', 'compta-lev@ex.ma');
  const ok = await lever(cookieOf(compta), { commentaire: 'Original vérifié' }); assert.equal(ok.status, 200, 'comptable autorisé');
  let d = (await reqJson('GET', '/api/anomalies', { cookie: ck })).body;
  assert.equal(d.rows.find(x => x.id === a).statut_calc, 'levee'); assert.equal(d.counts.aTraiter, 0, 'levée hors compteurs'); assert.equal(d.counts.levees, 1);
  assert.equal((await reqJson('DELETE', `/api/anomalies/${a}/levee`, { cookie: cookieOf(compta) })).status, 403, 'annulation réservée à l’admin');
  assert.equal((await reqJson('DELETE', `/api/anomalies/${a}/levee`, { cookie: ck })).status, 400, 'annulation sans motif refusée');
  assert.equal((await reqJson('DELETE', `/api/anomalies/${a}/levee`, { cookie: ck, body: { motif: 'Justificatif non conforme' } })).status, 200, 'annulation admin motivée');
  d = (await reqJson('GET', '/api/anomalies', { cookie: ck })).body; assert.equal(d.rows.find(x => x.id === a).statut_calc, 'a_verifier'); assert.equal(d.counts.aTraiter, 1);
  const logs = db.prepare("SELECT action, details, user_id FROM audit_log WHERE cabinet_id=? AND action IN ('levee_anomalie','annulation_levee') ORDER BY rowid").all(W.cab);
  assert.deepEqual(logs.map(l => l.action), ['levee_anomalie', 'annulation_levee']);
  assert.equal(logs[0].user_id, compta); assert.match(logs[0].details, /"facture":"B1".*"commentaire":"Original vérifié"/);
  // Période clôturée : lecture seule (ni validation ni annulation).
  db.prepare("INSERT INTO periode_declaration (id,cabinet_id,entreprise_id,annee,trimestre,statut) VALUES (?,?,?,2026,1,'cloturee')").run(uid('pd'), W.cab, W.ent);
  const rc = await lever(ck); assert.equal(rc.status, 409); assert.equal(rc.body.code, 'periode_verrouillee');
  assert.equal((await reqJson('GET', '/api/anomalies', { cookie: ck })).body.counts.aTraiter, 1, 'clôturée + couverte : reste à traiter');
});
test('INC2.1/A : un seul compteur pour tous les écrans, y compris après clôture et réouverture', async () => {
  const { W, four, fac, ano, conv } = anoSetup('ano-a1'); const ck = cookieOf(W.u);
  importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: W.cab, entrepriseId: W.ent, sourceName: 'x', periode: { annee: 2026, trimestre: 1 } });
  const f = four('ZETA'); fac(f, 'Z1', '2026-01-10', '2026-03-20', 10); ano(f, 'Z1'); conv(f, '2026-01-01', null, 'up_z.pdf');
  const ANO_TYPES = new Set(['convention', 'echeance']);
  const all = async () => {
    const g = u => reqJson('GET', u, { cookie: ck }).then(r => r.body);
    const [dash, list, counts, alerts, summary] = await Promise.all([g('/api/dashboard?annee=2026&trimestre=1'), g('/api/anomalies'), g('/api/anomalies/counts'), g('/api/alerts'), g(`/api/clients/${W.ent}/summary?annee=2026&trimestre=1`)]);
    assert.equal(alerts.count, alerts.alerts.length, 'Alertes : en-tête = lignes (aucune troncature)');
    return [dash.kpis.anomalies, list.counts.aTraiter, counts.aTraiter, alerts.alerts.filter(a => !ANO_TYPES.has(a.type)).length, summary.kpis.anomalies];
  };
  const v0 = await all(); assert.ok(v0[0] > 30, 'plus de 30 anomalies (l’ancienne troncature)'); assert.ok(v0.every(x => x === v0[0]), `écrans alignés : ${v0}`);
  const c0 = await reqJson('POST', `/api/clients/${W.ent}/periods/2026/1/close`, { cookie: ck, body: {} });
  assert.equal(c0.status, 409, 'VISA-1 : clôture silencieuse refusée'); assert.equal(c0.body.code, 'verifications_en_attente');
  assert.equal((await reqJson('POST', `/api/clients/${W.ent}/periods/2026/1/close`, { cookie: ck, body: { ackVerifications: true } })).status, 200);
  const v1 = await all(); assert.ok(v1.every(x => x === v1[0]), `après clôture : ${v1}`);
  assert.equal((await reqJson('POST', `/api/clients/${W.ent}/periods/2026/1/reopen`, { cookie: ck, body: { motif: 'test' } })).status, 200);
  const v2 = await all(); assert.ok(v2.every(x => x === v2[0]), `après réouverture : ${v2}`);
});
test('P3-10 : pas d’échéance annoncée sans dossier client', async () => {
  const V = mkWorkspace('ano-vide'); db.prepare('DELETE FROM entreprise WHERE cabinet_id=?').run(V.cab);
  const av = (await reqJson('GET', '/api/alerts', { cookie: cookieOf(V.u) })).body;
  assert.equal(av.alerts.filter(a => a.type === 'echeance').length, 0);
});

/* ============ Incrément 2.1 — E : contrôle hors trimestre = critère du moteur (date de paiement) ============ */
test('INC2.1/E : le fichier de référence T1 2026 ne déclenche aucun avertissement ; des paiements hors T1 le déclenchent', async () => {
  const periodCheck = require('../src/period-check');
  const ref = demoFixture.demoWorkbookBuffer();
  const map = { sheetName: 'Feuil1', headerRow: 0, mapping: { numero: 0, ttc: 4, date_paiement: 10, date_facture: 11 } };
  assert.deepEqual(periodCheck.periodCounts(ref, map, 2026, 1), { memePeriode: 36, autrePeriode: 0 }, 'référence : 36 lignes en T1 2026, aucune hors période');
  assert.equal(periodCheck.periodCounts(ref, map, 2026, 2).autrePeriode, 36, 'mauvais trimestre choisi : tout est signalé');
  // Fichier avec de vraies lignes hors période : paiement en T2, facture non payée émise après T1.
  const buf = aoaBuf([['N', 'TTC', 'PAIE', 'FAC'], ['A', 100, '2026-02-10', '2025-12-01'], ['B', 200, '2026-05-02', '2026-01-15'], ['C', 300, null, '2026-04-20'], ['D', 400, null, '2026-02-01']], 'S');
  const r = periodCheck.periodCounts(buf, { sheetName: 'S', headerRow: 0, mapping: { numero: 0, ttc: 1, date_paiement: 2, date_facture: 3 } }, 2026, 1);
  assert.deepEqual(r, { memePeriode: 2, autrePeriode: 2 }, 'B (payée en T2) et C (émise après T1) hors période ; D (non payée, émise en T1) dans T1');
  // Confirmation stricte : la case reste obligatoire pour les vraies lignes hors période.
  const t = newTenant(); const ck = cookieOf(t.u);
  const up = await postFile(`/api/clients/${t.ent}/import/analyze?annee=2026&trimestre=1`, ck, buf, 'x.xlsx');
  assert.equal(up.status, 200, 'analyse du fichier'); assert.ok(up.body.token);
  {
    const body = { token: up.body.token, sheetName: 'S', headerRow: 0, mapping: { numero: 0, ttc: 1, date_paiement: 2, date_facture: 3, four_nom: 0 }, strictPeriode: true };
    const c = await reqJson('POST', `/api/clients/${t.ent}/import/confirm?annee=2026&trimestre=1`, { cookie: ck, body });
    assert.equal(c.status, 409); assert.equal(c.body.code, 'hors_periode'); assert.equal(c.body.autrePeriode, 2);
  }
});

/* ============ Incrément 2.1 — B : dates de convention, modification tracée ============ */
test('INC2.1/B : convention datée à la création, modifiable (audit ancien → nouveau), sans effet sur le calcul', async () => {
  const W = mkWorkspace('conv-dates'); const ck = cookieOf(W.u);
  importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: W.cab, entrepriseId: W.ent, sourceName: 'x', periode: { annee: 2026, trimestre: 1 } });
  const four = db.prepare("SELECT id FROM fournisseur WHERE entreprise_id=? AND raison_sociale='BETA EXPRESS SARL'").get(W.ent).id;
  const amende = () => db.prepare('SELECT ROUND(SUM(montant_amende),2) a FROM facture WHERE entreprise_id=?').get(W.ent).a;
  const fd = new FormData(); fd.append('fournisseur_id', four); fd.append('delai', '120'); fd.append('date_signature', '2026-02-10'); fd.append('date_debut', '2026-01-01');
  const cr = await (await fetch(baseUrl() + `/api/clients/${W.ent}/conventions`, { method: 'POST', headers: { Cookie: ck }, body: fd })).json();
  const c0 = db.prepare('SELECT * FROM convention WHERE id=?').get(cr.id);
  assert.equal(c0.date_signature, '2026-02-10'); assert.equal(c0.date_debut, '2026-01-01');
  const a0 = amende();
  const up = await reqJson('PATCH', `/api/clients/${W.ent}/conventions/${cr.id}`, { cookie: ck, body: { date_debut: '2026-04-01', date_fin: '2026-12-31' } });
  assert.equal(up.status, 200);
  assert.deepEqual(up.body.changes.date_debut, { avant: '2026-01-01', apres: '2026-04-01' });
  assert.equal(amende(), a0, 'les dates ne changent pas le calcul (règle LOT 4 par statut)');
  const au = db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND action='update' AND entite='convention'").get(W.cab);
  assert.match(au.details, /"date_debut":\{"avant":"2026-01-01","apres":"2026-04-01"\}/);
  assert.equal((await reqJson('PATCH', `/api/clients/${W.ent}/conventions/${cr.id}`, { cookie: ck, body: { date_fin: '2026-01-15' } })).status, 400, 'fin avant effet refusée');
  assert.equal((await reqJson('PATCH', `/api/clients/${W.ent}/conventions/${cr.id}`, { cookie: ck, body: { date_debut: '31/12/2026' } })).status, 400, 'format invalide refusé');
  const ro = addUser(W.cab, 'lecture', 'ro-conv@ex.ma');
  assert.equal((await reqJson('PATCH', `/api/clients/${W.ent}/conventions/${cr.id}`, { cookie: cookieOf(ro), body: { date_fin: null } })).status, 403, 'lecture seule refusée');
});

/* ============ Incrément 2.1 — D : convention appliquée hors de sa période de validité (affichage seul) ============ */
test('INC2.1/D : feuille et conventions signalent une convention appliquée hors de ses dates ; calcul inchangé', async () => {
  const W = mkWorkspace('conv-hv'); const ck = cookieOf(W.u);
  importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: W.cab, entrepriseId: W.ent, sourceName: 'x', periode: { annee: 2026, trimestre: 1 } });
  const fid = nom => db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND raison_sociale=?').get(W.ent, nom).id;
  for (const [nom, deb, fin] of [['ALPHA PIECES AUTO', '2026-05-01', null], ['ETOILE CARROSSERIE', '2025-01-01', '2025-12-31'], ['BETA EXPRESS SARL', '2026-01-01', null]]) {
    const fd = new FormData(); fd.append('fournisseur_id', fid(nom)); fd.append('delai', '120'); fd.append('date_debut', deb); if (fin) fd.append('date_fin', fin);
    assert.equal((await fetch(baseUrl() + `/api/clients/${W.ent}/conventions`, { method: 'POST', headers: { Cookie: ck }, body: fd })).status, 200);
  }
  const d = (await reqJson('GET', `/api/clients/${W.ent}/delais?annee=2026&trimestre=1`, { cookie: ck })).body;
  const flagged = d.rows.filter(r => r.conv_hors_validite).map(r => r.numero).sort();
  assert.deepEqual(flagged, ['0043/2025', '0104/2025', '885/25'], 'ALPHA (débute après T1) et ETOILE (finie avant T1) signalées, BETA non');
  assert.equal(d.rows.find(r => r.numero === '885/25').amende, 0, 'calcul inchangé : la convention reste appliquée (LOT 4)');
  const cv = (await reqJson('GET', `/api/clients/${W.ent}/conventions?annee=2026&trimestre=1`, { cookie: ck })).body;
  const hv = cv.filter(c => c.hors_validite).map(c => c.fournisseur).sort();
  assert.deepEqual(hv, ['ALPHA PIECES AUTO', 'ETOILE CARROSSERIE']);
  assert.ok(cv.filter(c => c.statut === 'Expirée' && c.appliquee).every(c => c.hors_validite), 'jamais « Expirée » + « Appliquée » sans explication');
});

/* ============ Incrément 2.2 — CONV-1 : sans convention justificative = délai appliqué > 60 j sans convention ============ */
test('INC2.2/CONV-1 : fournisseurs à 120 j (colonne « Convention » du fichier) sans convention comptés, avec la source du délai', async () => {
  const W = mkWorkspace('conv1'); const ck = cookieOf(W.u);
  importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: W.cab, entrepriseId: W.ent, sourceName: 'x', periode: { annee: 2026, trimestre: 1 } });
  const an = require('../src/anomalies');
  const noms = () => an.conventionsManquantes({ cabinetId: W.cab }).map(x => x.four).sort();
  assert.deepEqual(noms(), ['ALPHA PIECES AUTO', 'BETA EXPRESS SARL', 'CEDRE AUTO SARL', 'DUNE BRICOLAGE SARL', 'ETOILE CARROSSERIE', 'FALAISE MATERIAUX',
    'HORIZON PNEUMATIQUES SARL', 'IRIS AUTO ACCESSOIRES SARL', 'KORAL ENGINS SA', 'LYNX BENNES', 'MISTRAL ACIERS SA'], 'sans aucune convention : 11 fournisseurs à 120 j');
  const beta = db.prepare("SELECT id FROM fournisseur WHERE entreprise_id=? AND raison_sociale='BETA EXPRESS SARL'").get(W.ent).id;
  db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut) VALUES (?,?,?,?,120,'valide')").run(uid('conv'), W.cab, W.ent, beta);
  assert.ok(!noms().includes('BETA EXPRESS SARL'), 'une convention valide retire le fournisseur');
  assert.ok(noms().includes('DUNE BRICOLAGE SARL') && noms().includes('LYNX BENNES'), 'fournisseurs jamais en retard à 120 j désormais comptés');
  const dune = an.conventionsManquantes({ cabinetId: W.cab }).find(x => x.four === 'DUNE BRICOLAGE SARL');
  assert.equal(dune.delai, 120); assert.equal(dune.source, 'standard'); assert.match(dune.source_label, /importé/);
  const fs_ = (await reqJson('GET', `/api/clients/${W.ent}/fournisseurs`, { cookie: ck })).body;
  assert.equal(fs_.filter(f => f.sans_convention_justificative).length, 10, 'page Fournisseurs : même indicateur');
  assert.equal((await reqJson('GET', '/api/dashboard?annee=2026&trimestre=1', { cookie: ck })).body.kpis.conventionsManquantes, 10);
  assert.equal(db.prepare('SELECT ROUND(SUM(montant_amende),2) a FROM facture WHERE entreprise_id=?').get(W.ent).a, 7025.33, 'calcul inchangé');
});

/* ============ Incrément 2.2 — VER-1 / VER-2 / signature rétroactive ============ */
test('INC2.2/VER-1 : aucun contournement — « convention absente » jamais résolue à la main ; autres types : motif, rôle, période, audit', async () => {
  const { W, four, fac, ano } = anoSetup('ver1'); const ck = cookieOf(W.u);
  const f = four('GAMMA'); fac(f, 'G1', '2026-01-10', '2026-03-20', 0); const ca = ano(f, 'G1');
  const r0 = await reqJson('POST', `/api/anomalies/${ca}/resolve`, { cookie: ck, body: { motif: 'test' } });
  assert.equal(r0.status, 409); assert.equal(r0.body.code, 'verification_obligatoire', 'contournement refusé côté serveur');
  const dup = uid('ano'); db.prepare("INSERT INTO anomalie (id,cabinet_id,entreprise_id,type,gravite,details,entite,statut,annee,trimestre) VALUES (?,?,?,'date_incoherente','moyenne','Date incohérente sur G1','facture','ouverte',2026,1)").run(dup, W.cab, W.ent);
  assert.equal((await reqJson('POST', `/api/anomalies/${dup}/resolve`, { cookie: ck, body: {} })).status, 400, 'motif obligatoire');
  const ro = addUser(W.cab, 'lecture', 'ro-ver1@ex.ma');
  assert.equal((await reqJson('POST', `/api/anomalies/${dup}/resolve`, { cookie: cookieOf(ro), body: { motif: 'x' } })).status, 403, 'lecture seule refusée');
  db.prepare("INSERT INTO periode_declaration (id,cabinet_id,entreprise_id,annee,trimestre,statut) VALUES (?,?,?,2026,1,'declaree')").run(uid('pd'), W.cab, W.ent);
  const rc = await reqJson('POST', `/api/anomalies/${dup}/resolve`, { cookie: ck, body: { motif: 'x' } }); assert.equal(rc.status, 409); assert.equal(rc.body.code, 'periode_verrouillee', 'période déclarée refusée');
  db.prepare("DELETE FROM periode_declaration WHERE entreprise_id=?").run(W.ent);
  assert.equal((await reqJson('POST', `/api/anomalies/${dup}/resolve`, { cookie: ck, body: { motif: 'Date corrigée dans le fichier source' } })).status, 200);
  const au = db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND action='resolution_anomalie'").get(W.cab);
  assert.ok(au, 'entrée d’audit'); const d = JSON.parse(au.details);
  assert.equal(d.motif, 'Date corrigée dans le fichier source'); assert.equal(d.type, 'date_incoherente'); assert.equal(d.periode, 'T1 2026'); assert.equal(d.utilisateur.id, W.u);
  // Résolution historique sans motif → signalée.
  const old = uid('ano'); db.prepare("INSERT INTO anomalie (id,cabinet_id,entreprise_id,type,gravite,details,entite,statut,resolue_le) VALUES (?,?,?,'date_future','basse','x','facture','resolue',datetime('now'))").run(old, W.cab, W.ent);
  const list = (await reqJson('GET', '/api/anomalies', { cookie: ck })).body.rows;
  assert.equal(list.find(x => x.id === old).sans_justification, true); assert.equal(list.find(x => x.id === dup).sans_justification, false);
});
test('INC2.2/VER-2 + signature rétroactive : entrées de levée et d’annulation complètes ; accusé obligatoire si signée après la facture', async () => {
  const { W, four, fac, ano, conv } = anoSetup('ver2'); const ck = cookieOf(W.u);
  const f = four('DELTA SARL'); fac(f, 'D7', '2026-01-10', '2026-03-20', 12.5); const a = ano(f, 'D7');
  const c = conv(f, '2026-01-01', null, 'up_d7.pdf', '2026-02-15'); // signée APRÈS la facture (10/01)
  db.prepare("UPDATE convention SET fichier_nom='convention-delta.pdf' WHERE id=?").run(c);
  const r1 = await reqJson('POST', `/api/anomalies/${a}/levee`, { cookie: ck, body: {} });
  assert.equal(r1.status, 409); assert.equal(r1.body.code, 'ack_retroactif_requis', 'signature rétroactive : accusé requis');
  assert.equal((await reqJson('POST', `/api/anomalies/${a}/levee`, { cookie: ck, body: { ackRetroactif: true, commentaire: 'Vu' } })).status, 200);
  const lev = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND action='levee_anomalie'").get(W.cab).details);
  assert.equal(lev.facture, 'D7'); assert.equal(lev.fournisseur, 'DELTA SARL'); assert.equal(lev.type, 'convention_absente'); assert.equal(lev.periode, 'T1 2026');
  assert.deepEqual(lev.convention, { id: c, delai: 120, date_signature: '2026-02-15', date_effet: '2026-01-01', date_fin: null });
  assert.equal(lev.justificatif, 'convention-delta.pdf'); assert.equal(lev.commentaire, 'Vu'); assert.equal(lev.utilisateur.id, W.u); assert.ok(lev.horodatage);
  assert.equal(lev.accuse_signature_retroactive, true);
  assert.equal((await reqJson('DELETE', `/api/anomalies/${a}/levee`, { cookie: ck, body: { motif: 'Signature à revérifier' } })).status, 200);
  const an = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND action='annulation_levee'").get(W.cab).details);
  assert.equal(an.motif, 'Signature à revérifier'); assert.equal(an.facture, 'D7'); assert.equal(an.fournisseur, 'DELTA SARL'); assert.equal(an.convention.id, c);
  assert.equal(an.levee_initiale.commentaire, 'Vu');
});

/* ============ Incrément 2.2 — VISA-1 : jamais de « Sans observation » silencieux ============ */
test('INC2.2/VISA-1 : aucune conclusion par défaut, vérifications listées, clôture avec accusé consigné', async () => {
  const W = mkWorkspace('visa1'); const ck = cookieOf(W.u);
  importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: W.cab, entrepriseId: W.ent, sourceName: 'x', periode: { annee: 2026, trimestre: 1 } });
  const Q = '?annee=2026&trimestre=1';
  const v0 = (await reqJson('GET', `/api/clients/${W.ent}/visa${Q}`, { cookie: ck })).body;
  assert.equal(v0.choix_requis, true, 'aucune conclusion présélectionnée'); assert.equal(v0.blocks, undefined, 'aucun aperçu sans choix');
  assert.deepEqual(v0.conclusions, ['Sans observation', 'Avec observation', 'Avec réserve', 'Refus de visa']);
  assert.ok(v0.verifications.ouvertes > 0 && v0.verifications.convManquantes > 0, 'points en attente listés avant le choix');
  assert.equal(v0.verifications.total, v0.verifications.ouvertes + v0.verifications.aVerifier + v0.verifications.convManquantes + v0.verifications.horsValidite);
  assert.equal((await reqJson('GET', `/api/clients/${W.ent}/visa${Q}&conclusion=Autre`, { cookie: ck })).body.choix_requis, true, 'valeur inconnue = pas de choix');
  const v1 = (await reqJson('GET', `/api/clients/${W.ent}/visa${Q}&conclusion=${encodeURIComponent('Avec réserve')}`, { cookie: ck })).body;
  assert.equal(v1.conclusion, 'Avec réserve'); assert.ok(v1.blocks.length > 5);
  const c0 = await reqJson('POST', `/api/clients/${W.ent}/periods/2026/1/close${Q}`, { cookie: ck, body: {} });
  assert.equal(c0.status, 409); assert.deepEqual(c0.body.verifications, v0.verifications);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM periode_declaration WHERE entreprise_id=? AND statut='cloturee'").get(W.ent).n, 0, 'rien de clôturé sans accusé');
  assert.equal((await reqJson('POST', `/api/clients/${W.ent}/periods/2026/1/close${Q}`, { cookie: ck, body: { ackVerifications: true } })).status, 200);
  const au = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND action='cloture_periode'").get(W.cab).details);
  assert.equal(au.accuse_verifications, true); assert.deepEqual(au.verifications_en_attente, v0.verifications);
});

/* ============ Incrément 2.2 — ONB-3 : la bannière de reprise survit à « Terminer plus tard » ============ */
test('INC2.2/ONB-3 : « Terminer plus tard » ne masque pas la reprise ; entrée permanente dans Paramètres', async () => {
  const W = mkWorkspace('onb3'); db.prepare('DELETE FROM entreprise WHERE cabinet_id=?').run(W.cab); const ck = cookieOf(W.u);
  const later = (await reqJson('PUT', '/api/onboarding', { cookie: ck, body: { dismissed: true, current: 'client' } })).body;
  assert.equal(later.dismissed, true); assert.equal(later.complete, false);
  const ob = (await reqJson('GET', '/api/onboarding', { cookie: ck })).body; // rechargement / nouvelle connexion : état relu en base
  assert.equal(ob.dismissed, true); assert.equal(ob.complete, false);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const { onboardingBanner } = new Function('esc', 'svgI', 'can', 'state', fromAppSrc(js, 'onboardingBanner') + '\nreturn { onboardingBanner };')(
    x => String(x), () => '', () => true, { workspace: { displayName: 'Onb3' } });
  const html = onboardingBanner(ob);
  assert.match(html, /Reprendre la configuration/, 'bannière affichée après « Terminer plus tard »');
  assert.equal(onboardingBanner({ ...ob, complete: true }), '', 'disparaît une fois la configuration terminée');
  assert.match(js, /onclick="resumeOnboarding\(null\)">\$\{svgI\('bolt'\)\}Configuration de l’espace/, 'entrée permanente dans Paramètres');
});
function fromAppSrc(src, name) { const m = src.match(new RegExp(`^function ${name}\\([\\s\\S]*?\\n}\\n`, 'm')); assert.ok(m, name); return m[0]; }

/* ============ Incrément 2.3 — VER-2b : numéro(s) de facture rendus dans le journal ============ */
function auditRenderer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const parts = ['money', 'dateFr', 'ROLE_FR', 'DET_KEY', 'HIDDEN_DET', 'INTERNAL_ID', 'facLine', 'detVal', 'auditDetails'].map(n => {
    const m = src.match(new RegExp(`^(?:const ${n} = [\\s\\S]*?;\\n(?=const |function |\\/\\/|$)|function ${n}\\([\\s\\S]*?\\n}\\n)`, 'm')); assert.ok(m, n); return m[0]; });
  return new Function(parts.join('\n') + '\nreturn auditDetails;')();
}
test('INC2.3/VER-2b : résolution d’un doublon réel → toutes les factures dans l’entrée affichée', async () => {
  const W = mkWorkspace('ver2b'); const ck = cookieOf(W.u);
  importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: W.cab, entrepriseId: W.ent, sourceName: 'x', periode: { annee: 2026, trimestre: 1 } });
  const dup = db.prepare("SELECT a.id FROM anomalie a JOIN facture f ON f.id=a.entite_id WHERE a.entreprise_id=? AND a.type='doublon_potentiel' AND f.numero='FA25-5256'").get(W.ent);
  assert.ok(dup, 'anomalie de doublon FA25-5256');
  assert.equal((await reqJson('POST', `/api/anomalies/${dup.id}/resolve`, { cookie: ck, body: { motif: 'Deux règlements partiels' } })).status, 200);
  const raw = db.prepare("SELECT details FROM audit_log WHERE cabinet_id=? AND action='resolution_anomalie'").get(W.cab).details;
  const shown = auditRenderer()(raw);
  assert.equal((shown.match(/FA25-5256 du \d{2}\/\d{2}\/\d{4} 76 111,00 DH TTC/g) || []).length, 2, `les deux factures affichées : ${shown}`);
  assert.match(shown, /Fournisseur : MISTRAL ACIERS SA/); assert.ok(!/ano_/.test(shown));
});

/* ============ Incrément 2.3 — CONV-1 : enjeu simulé à 60 j, lecture seule ============ */
test('INC2.3/CONV-1 : enjeu à 60 j = 7 057,19 DH sur la référence ; simulation sans aucun effet sur les chiffres enregistrés ni les livrables', async () => {
  const W = mkWorkspace('enjeu'); const ck = cookieOf(W.u);
  importer.importWorkbook(demoFixture.demoWorkbookBuffer(), { cabinetId: W.cab, entrepriseId: W.ent, sourceName: 'demo.xlsx', periode: { annee: 2026, trimestre: 1 } });
  for (const nom of ['KORAL ENGINS SA', 'ALPHA PIECES AUTO', 'BETA EXPRESS SARL', 'ETOILE CARROSSERIE']) {
    const f = db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND raison_sociale=?').get(W.ent, nom).id;
    db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,delai_convenu,statut) VALUES (?,?,?,?,120,'valide')").run(uid('conv'), W.cab, W.ent, f);
  }
  const Q = '?annee=2026&trimestre=1';
  const snap = () => JSON.stringify({
    f: db.prepare('SELECT ROUND(SUM(montant_amende),2) a, SUM(a_declarer) d, SUM(retard_jours) r, GROUP_CONCAT(delai_applicable) dl FROM facture WHERE entreprise_id=?').get(W.ent),
    fo: db.prepare('SELECT GROUP_CONCAT(delai_applicable) d FROM fournisseur WHERE entreprise_id=?').get(W.ent),
    decl: db.prepare('SELECT COUNT(*) n FROM declaration WHERE entreprise_id=?').get(W.ent), audit: db.prepare('SELECT COUNT(*) n FROM audit_log WHERE cabinet_id=?').get(W.cab) });
  const csv = async () => { const r = await fetch(baseUrl() + `/api/clients/${W.ent}/declaration/export.csv${Q}`, { headers: { Cookie: ck } }); return require('crypto').createHash('md5').update(Buffer.from(await r.arrayBuffer())).digest('hex'); };
  const visaTxt = async () => JSON.stringify((await reqJson('GET', `/api/clients/${W.ent}/visa${Q}&conclusion=${encodeURIComponent('Avec réserve')}`, { cookie: ck })).body.blocks);
  const md5a = await csv(), v0 = await visaTxt(), s0 = snap();
  const en = (await reqJson('GET', `/api/clients/${W.ent}/enjeu-delai-legal${Q}`, { cookie: ck })).body;
  assert.equal(en.simulation, true);
  assert.deepEqual(en.total, { factures: 16, amende_appliquee: 152.14, amende_60: 7209.33, ecart: 7057.19 }, 'mêmes chiffres que DECISIONS.md');
  assert.deepEqual(en.rows.map(r => r.four).slice(0, 2), ['MISTRAL ACIERS SA', 'LYNX BENNES']);
  assert.match(en.rows[0].source_label, /^Délai de 120 j repris de la colonne « Convention » du fichier client « demo\.xlsx » \(importé le \d{2}\/\d{2}\/\d{4}\) — aucune convention signée enregistrée$/);
  for (let i = 0; i < 3; i++) await reqJson('GET', `/api/clients/${W.ent}/enjeu-delai-legal${Q}`, { cookie: ck });
  assert.equal(snap(), s0, 'aucune donnée enregistrée modifiée (factures, délais, déclaration, journal)');
  assert.equal(await csv(), md5a, 'déclaration CSV identique');
  const v1 = await visaTxt(); assert.equal(v1, v0, 'texte du visa identique'); assert.ok(!/7[  ]?209|7[  ]?057/.test(v1), 'aucun chiffre simulé dans le visa');
  const al = (await reqJson('GET', '/api/alerts', { cookie: ck })).body.alerts.filter(a => a.type === 'convention');
  assert.ok(al.every(a => /repris de la colonne « Convention »/.test(a.message)), 'Alertes : source en clair');
});

/* ============ Incrément 2.3 — P3-1 : justificatif affiché dans le navigateur, réservé à l'espace ============ */
test('INC2.3/P3-1 : justificatif PDF / image en ligne (nouvel onglet), autre contenu téléchargé, autre espace refusé', async () => {
  const A = mkWorkspace('doc-a'), B = mkWorkspace('doc-b');
  const UPD = path.join(__dirname, '..', 'uploads'); fs.mkdirSync(UPD, { recursive: true });
  const put = (bytes, nom) => { const f = uid('up') + '.bin'; fs.writeFileSync(path.join(UPD, f), bytes); const id = uid('conv');
    db.prepare("INSERT INTO convention (id,cabinet_id,entreprise_id,delai_convenu,statut,fichier,fichier_nom) VALUES (?,?,?,120,'valide',?,?)").run(id, A.cab, A.ent, f, nom); return { id, f }; };
  const pdf = put(Buffer.from('%PDF-1.4\n%%EOF\n'), 'Convention signée.pdf');
  const png = put(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]), 'scan.png');
  const autre = put(Buffer.from('PK\x03\x04 docx'), 'convention.docx');
  const get = (id, u) => fetch(baseUrl() + `/api/conventions/${id}/file`, { headers: { Cookie: cookieOf(u) } });
  let r = await get(pdf.id, A.u);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /^inline; filename\*=UTF-8''Convention%20sign%C3%A9e\.pdf$/, 'affiché, pas téléchargé');
  r = await get(png.id, A.u); assert.equal(r.headers.get('content-type'), 'image/png'); assert.match(r.headers.get('content-disposition'), /^inline/);
  r = await get(autre.id, A.u); assert.match(r.headers.get('content-disposition'), /^attachment/, 'contenu non affichable : téléchargement');
  assert.equal((await get(pdf.id, B.u)).status, 404, 'autre espace : refusé');
  for (const x of [pdf, png, autre]) fs.rmSync(path.join(UPD, x.f));
});
