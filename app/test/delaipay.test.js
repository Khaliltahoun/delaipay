'use strict';
/* Suite de tests automatisés DelaiPay — node:test.  Lancer : npm test  (ou node --test) */
const { test } = require('node:test');
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
