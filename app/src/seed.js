'use strict';
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { hashPassword } = require('./auth');
const { uid, normalizeIce } = require('./util');
const crypto = require('crypto');
const { importWorkbook } = require('./importer');
const { DEMO_CLIENT, DEMO_PERSONA, DEMO_CONVENTIONS, DEMO_SOURCE_NAME, demoWorkbookBuffer } = require('./demo-fixture');

const UP = require('./paths').UPLOADS_DIR;
fs.mkdirSync(UP, { recursive: true });

const TAUX = [
  { taux: 0.03,   d: '2022-09-01', f: '2024-06-25', r: 'BAM 3,00 %' },
  { taux: 0.0275, d: '2024-06-26', f: '2024-12-17', r: 'BAM 2,75 %' },
  { taux: 0.025,  d: '2024-12-18', f: '2025-03-17', r: 'BAM 2,50 %' },
  { taux: 0.0225, d: '2025-03-18', f: null,         r: 'BAM 2,25 %' },
];

// Mot de passe initial : ADMIN_PASSWORD, sinon (hors production) un mot de passe aléatoire affiché UNE fois au démarrage.
function initialPassword() {
  if (process.env.ADMIN_PASSWORD) return { password: process.env.ADMIN_PASSWORD, generated: false };
  if (process.env.NODE_ENV === 'production')
    throw new Error('ADMIN_PASSWORD requis en production pour créer le compte initial.');
  return { password: 'Demo-' + crypto.randomBytes(9).toString('base64url'), generated: true };
}

// Document PDF de démonstration joint à chaque convention fictive (aucun document réel).
function demoConventionPdf(nomFournisseur) {
  return new Promise((resolve) => {
    try {
      const PDFDocument = require('pdfkit');
      const stored = uid('up') + '.pdf';
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const out = fs.createWriteStream(path.join(UP, stored));
      out.on('finish', () => resolve(stored)); out.on('error', () => resolve(null));
      doc.pipe(out);
      doc.fontSize(16).text('Convention relative aux délais de paiement', { align: 'center' }).moveDown();
      doc.fontSize(11).text(`Document FICTIF de démonstration — ${DEMO_CLIENT.raison_sociale} / ${nomFournisseur}.`)
        .moveDown().text('Délai convenu : 120 jours à compter de la date de facture.');
      doc.end();
    } catch (_) { resolve(null); }
  });
}

async function ensureSeed() {
  const existing = db.prepare('SELECT COUNT(*) n FROM cabinet').get().n;
  if (existing > 0) return { seeded: false };

  const email = (process.env.ADMIN_EMAIL || DEMO_PERSONA.email).toLowerCase();
  const { password, generated } = initialPassword();

  const cabinetId = uid('cab');
  db.prepare('INSERT INTO cabinet (id, nom, slug, plan) VALUES (?,?,?,?)')
    .run(cabinetId, 'HLZ Consulting', 'hlz', 'pro');
  db.prepare(`INSERT INTO utilisateur (id, cabinet_id, nom, email, password_hash, role, initiales, titre)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid('usr'), cabinetId, DEMO_PERSONA.nom, email, hashPassword(password), 'admin', DEMO_PERSONA.initiales, DEMO_PERSONA.titre);

  for (const t of TAUX)
    db.prepare('INSERT INTO taux_bam (id, cabinet_id, taux, date_debut, date_fin, reference) VALUES (?,?,?,?,?,?)')
      .run(uid('tx'), null, t.taux, t.d, t.f, t.r);

  // Client de démonstration FICTIF (données de référence T1 2026)
  const c = DEMO_CLIENT;
  const entId = uid('ent');
  db.prepare(`INSERT INTO entreprise (id, cabinet_id, raison_sociale, ice, if_fiscal, rc, forme_juridique,
      secteur, ville, adresse, ca_ht, exercice_ref, email, expert_responsable)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(entId, cabinetId, c.raison_sociale, c.ice, c.if_fiscal, c.rc, c.forme_juridique,
      c.secteur, c.ville, c.adresse, c.ca_ht, c.exercice_ref, c.email, DEMO_PERSONA.nom);

  let imported = 0;
  try {
    const r = importWorkbook(demoWorkbookBuffer(), {
      cabinetId, entrepriseId: entId, sourceName: DEMO_SOURCE_NAME, periode: { annee: 2026, trimestre: 1 },
    });
    imported = r.imported;
  } catch (e) { console.warn('  (seed) import des données de démonstration ignoré :', e.message); }

  // Conventions de démonstration (rattachées par ICE fictif)
  for (const cf of DEMO_CONVENTIONS) {
    const four = db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND ice=?').get(entId, normalizeIce(cf.ice));
    if (!four) continue;
    const stored = await demoConventionPdf(cf.nom);
    db.prepare(`INSERT INTO convention (id, cabinet_id, entreprise_id, fournisseur_id, objet, delai_convenu,
        statut, conforme, fichier, fichier_nom) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(uid('conv'), cabinetId, entId, four.id, 'Convention relative aux délais de paiement', 120,
        'valide', 1, stored, `Convention ${cf.nom} (démo).pdf`);
    db.prepare('UPDATE fournisseur SET delai_applicable=120 WHERE id=?').run(four.id);
  }

  console.log(`  (seed) Cabinet HLZ + client de démonstration ${c.raison_sociale} · ${imported} facture(s) importée(s).`);
  return { seeded: true, email, password: generated ? password : null };
}

module.exports = { ensureSeed };
