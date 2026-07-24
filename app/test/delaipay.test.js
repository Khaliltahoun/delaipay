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
  // Nouvelle règle : les doublons sont GARDÉS et SIGNALÉS (paiement partiel / facture scindée),
  // pas supprimés. Un ré-import recrée donc les lignes, toutes marquées « doublon potentiel ».
  const r2 = importer.confirmImport(buf, { ...opts, sourceName: 'ferma2.xlsx' });
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
 *  - exposition API + non-régression métier (CADOZAT, réseau, conventions, dates)
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
test('doublon/E34-E36 CADOZAT : 36 factures, 7025,33 DH, 2 doublons à amende nulle', { skip: !fs.existsSync(path.join(DOCS, 'DELAI.xlsx')) }, () => {
  const { cab, ent } = seedCab();
  const r = importer.importWorkbook(fs.readFileSync(path.join(DOCS, 'DELAI.xlsx')), { cabinetId: cab, entrepriseId: ent, sourceName: 'DELAI.xlsx', periode: { annee: 2026, trimestre: 1 } });
  assert.equal(r.imported, 36, 'CADOZAT = 36 factures');
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
