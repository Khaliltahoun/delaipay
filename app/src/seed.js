'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { hashPassword } = require('./auth');
const { uid, normalizeIce } = require('./util');
const { importWorkbook } = require('./importer');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const UP = path.join(__dirname, '..', 'uploads');

const TAUX = [
  { taux: 0.03,   d: '2022-09-01', f: '2024-06-25', r: 'BAM 3,00 %' },
  { taux: 0.0275, d: '2024-06-26', f: '2024-12-17', r: 'BAM 2,75 %' },
  { taux: 0.025,  d: '2024-12-18', f: '2025-03-17', r: 'BAM 2,50 %' },
  { taux: 0.0225, d: '2025-03-18', f: null,         r: 'BAM 2,25 %' },
];

// Conventions réelles fournies (docs/), rattachées par ICE
const CONV_FILES = [
  { ice: '001534945000026', file: 'CADOZAT CONVENTION 2 TMM.pdf', nom: 'TRACTAFRIC MOTORS MAROC' },
  { ice: '000065153000061', file: 'CADOZAT CONVENTTION BATHA AUTO.pdf', nom: 'BATHA AUTO' },
  { ice: '002158803000007', file: 'CADOZAT CONVENTION  3.pdf', nom: 'BG EXPRESS SARL' },
  { ice: '001463160000064', file: 'CADOZAT CONVRNTION 4.pdf', nom: 'CARROSSERIE PONT DU SOUSS' },
];

async function ensureSeed() {
  const existing = db.prepare('SELECT COUNT(*) n FROM cabinet').get().n;
  if (existing > 0) return { seeded: false };

  const email = (process.env.ADMIN_EMAIL || 'zahra@hlz.ma').toLowerCase();
  // En production, refuser un mot de passe par défaut : ADMIN_PASSWORD est obligatoire.
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD)
    throw new Error('ADMIN_PASSWORD requis en production pour créer le compte initial.');
  const password = process.env.ADMIN_PASSWORD || 'DelaiPay2026!';

  const cabinetId = uid('cab');
  db.prepare('INSERT INTO cabinet (id, nom, slug, plan) VALUES (?,?,?,?)')
    .run(cabinetId, 'HLZ Consulting', 'hlz', 'pro');
  db.prepare(`INSERT INTO utilisateur (id, cabinet_id, nom, email, password_hash, role, initiales, titre)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid('usr'), cabinetId, 'Zahra Hajrioui', email, hashPassword(password), 'admin', 'ZH', 'Commissaire aux comptes');

  for (const t of TAUX)
    db.prepare('INSERT INTO taux_bam (id, cabinet_id, taux, date_debut, date_fin, reference) VALUES (?,?,?,?,?,?)')
      .run(uid('tx'), null, t.taux, t.d, t.f, t.r);

  // Client réel : CADOZAT
  const entId = uid('ent');
  db.prepare(`INSERT INTO entreprise (id, cabinet_id, raison_sociale, ice, if_fiscal, rc, forme_juridique,
      secteur, ville, adresse, ca_ht, exercice_ref, email, expert_responsable)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(entId, cabinetId, 'STE CADOZAT SARL', '001538487000034', '6590278', '559', 'SARL',
      'Négoce & distribution automobile', 'Ouarzazate', 'AV AL MAGHRIB AL ARABI N°189, Ouarzazate',
      60457607.22, 2026, 'contact@cadozat.ma', 'Zahra Hajrioui');

  // Import du fichier réel DELAI.xlsx (reproduit la déclaration T1 2026) sinon TVA
  let imported = 0;
  try {
    const delaiPath = path.join(DOCS, 'DELAI.xlsx');
    if (fs.existsSync(delaiPath)) {
      const r = importWorkbook(fs.readFileSync(delaiPath), {
        cabinetId, entrepriseId: entId, sourceName: 'DELAI.xlsx (réel)',
        periode: { annee: 2026, trimestre: 1 },
      });
      imported = r.imported;
    } else {
      for (const f of ['CADOZAT  TVA 1.xlsx', 'CADOZAT TVA 2.xlsx', 'CADOZAT TVA 3.xlsx']) {
        const p = path.join(DOCS, f);
        if (fs.existsSync(p)) {
          const r = importWorkbook(fs.readFileSync(p), { cabinetId, entrepriseId: entId, sourceName: f });
          imported += r.imported;
        }
      }
    }
  } catch (e) { console.warn('  (seed) import documents réels ignoré :', e.message); }

  // Conventions réelles (rattachées par ICE, fichiers copiés dans uploads/)
  for (const cf of CONV_FILES) {
    const iceN = normalizeIce(cf.ice);
    const four = db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND ice=?').get(entId, iceN);
    if (!four) continue;
    let stored = null;
    try {
      const src = path.join(DOCS, cf.file);
      if (fs.existsSync(src)) { stored = uid('up') + '.pdf'; fs.copyFileSync(src, path.join(UP, stored)); }
    } catch (_) {}
    db.prepare(`INSERT INTO convention (id, cabinet_id, entreprise_id, fournisseur_id, objet, delai_convenu,
        statut, conforme, fichier, fichier_nom) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uid('conv'), cabinetId, entId, four.id, 'Convention relative aux délais de paiement', 120,
        'valide', 1, stored, cf.file);
    db.prepare('UPDATE fournisseur SET delai_applicable=120 WHERE id=?').run(four.id);
  }

  console.log(`  (seed) Cabinet HLZ + client CADOZAT · ${imported} facture(s) importée(s).`);
  return { seeded: true, email, password };
}

module.exports = { ensureSeed };
