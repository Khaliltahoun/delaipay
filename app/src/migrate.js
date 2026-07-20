'use strict';
/**
 * Migration idempotente des données existantes vers le modèle « périodes + lots d'import ».
 * Sûr à relancer. Ne supprime ni ne modifie les montants des factures.
 * Usage : node src/migrate.js        (respecte DB_PATH)
 */
const { db } = require('./db');           // exécute aussi le DDL idempotent (tables/colonnes/index)
const periode = require('./periode');
const { uid } = require('./util');

function count(sql, ...a) { return db.prepare(sql).get(...a).n; }
const report = { avant: {}, apres: {}, lots: 0, periodes: 0, factures_origine: 0, incertains: [] };

report.avant = {
  entreprises: count('SELECT COUNT(*) n FROM entreprise'),
  factures: count('SELECT COUNT(*) n FROM facture'),
  conventions: count('SELECT COUNT(*) n FROM convention'),
  documents: count('SELECT COUNT(*) n FROM document'),
};

db.exec('BEGIN');
try {
  /* 1) Période d'origine de chaque facture = trimestre de la date de facture (là où c'est déterminable). */
  const facs = db.prepare('SELECT id, date_facture, annee, trimestre FROM facture WHERE annee_origine IS NULL').all();
  const updOrigine = db.prepare('UPDATE facture SET annee_origine=?, trimestre_origine=? WHERE id=?');
  let sansDate = 0;
  for (const f of facs) {
    const m = f.date_facture && String(f.date_facture).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const a = +m[1], t = periode.quarterOfMonth(+m[2]);
      updOrigine.run(a, t, f.id);
      report.factures_origine++;
    } else {
      // pas de date de facture fiable → on rattache à la période déclarée existante, mais on le signale
      updOrigine.run(f.annee || null, f.trimestre || null, f.id);
      sansDate++;
    }
  }
  if (sansDate) report.incertains.push(`${sansDate} facture(s) sans date de facture exploitable → période d'origine = période déclarée (à vérifier).`);

  /* 2) Reconstruire un import_lot par import_id existant (l'id du lot = l'import_id d'origine, donc idempotent). */
  const lots = db.prepare(`
    SELECT f.import_id AS iid, f.entreprise_id, f.cabinet_id,
           COUNT(*) n, COALESCE(SUM(f.ttc),0) ttc,
           MAX(f.source_import) src, MIN(f.created_at) crea
    FROM facture f WHERE f.import_id IS NOT NULL GROUP BY f.import_id`).all();
  const insLot = db.prepare(`INSERT INTO import_lot
    (id, cabinet_id, entreprise_id, document_id, annee, trimestre, source_nom, statut,
     nb_lignes_total, nb_lignes_valides, total_ttc, confirmed_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const lotExists = db.prepare('SELECT 1 FROM import_lot WHERE id=?');
  const domPeriod = db.prepare(`SELECT annee, trimestre, COUNT(*) n FROM facture WHERE import_id=?
                                GROUP BY annee, trimestre ORDER BY n DESC LIMIT 1`);
  const linkFac = db.prepare('UPDATE facture SET import_lot_id=? WHERE import_id=? AND import_lot_id IS NULL');
  for (const l of lots) {
    if (!lotExists.get(l.iid)) {
      const per = domPeriod.get(l.iid) || {};
      insLot.run(l.iid, l.cabinet_id, l.entreprise_id, null, per.annee || null, per.trimestre || null,
        l.src || null, 'confirme', l.n, l.n, l.ttc, l.crea || null, l.crea || null);
      report.lots++;
    }
    linkFac.run(l.iid, l.iid);
  }

  /* 3) Créer une periode_declaration par (entreprise, annee, trimestre) réellement présente. */
  const pers = db.prepare(`SELECT DISTINCT entreprise_id, cabinet_id, annee, trimestre
                           FROM facture WHERE annee IS NOT NULL AND trimestre IS NOT NULL`).all();
  const perExists = db.prepare('SELECT 1 FROM periode_declaration WHERE entreprise_id=? AND annee=? AND trimestre=?');
  const insPer = db.prepare(`INSERT INTO periode_declaration
    (id, cabinet_id, entreprise_id, annee, trimestre, date_debut, date_fin, mois_traitement, annee_traitement, statut)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const p of pers) {
    if (perExists.get(p.entreprise_id, p.annee, p.trimestre)) continue;
    if (!periode.isValidPeriod(p.annee, p.trimestre)) { report.incertains.push(`Période invalide ignorée : ${p.annee}-T${p.trimestre} (entreprise ${p.entreprise_id}).`); continue; }
    const info = periode.periodInfo(p.annee, p.trimestre);
    insPer.run(uid('per'), p.cabinet_id, p.entreprise_id, p.annee, p.trimestre,
      info.date_debut, info.date_fin, info.mois_traitement, info.annee_traitement,
      periode.defaultStatut(p.annee, p.trimestre));
    report.periodes++;
  }

  /* 4) Rattacher les anomalies existantes à leur période via la facture liée (si possible). */
  db.exec(`UPDATE anomalie SET annee=(SELECT f.annee FROM facture f WHERE f.id=anomalie.entite_id),
                                trimestre=(SELECT f.trimestre FROM facture f WHERE f.id=anomalie.entite_id)
           WHERE annee IS NULL AND entite='facture'
             AND EXISTS (SELECT 1 FROM facture f WHERE f.id=anomalie.entite_id)`);

  /* 5) Revue des doublons : les factures déjà marquées « doublon potentiel » (avant l'ajout de
   *    statut_doublon) passent à l'état courant 'potentiel'. Idempotent : ne rouvre jamais une
   *    revue déjà tranchée ('confirme' / 'faux_positif'). Aucune facture n'est supprimée ni fusionnée. */
  report.doublons_potentiels = db.prepare(
    `UPDATE facture SET statut_doublon='potentiel'
      WHERE doublon_potentiel=1 AND (statut_doublon IS NULL OR statut_doublon='aucun')`).run().changes;

  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('MIGRATION ÉCHOUÉE (rollback) :', e.message);
  process.exit(1);
}

report.apres = {
  entreprises: count('SELECT COUNT(*) n FROM entreprise'),
  factures: count('SELECT COUNT(*) n FROM facture'),
  conventions: count('SELECT COUNT(*) n FROM convention'),
  periode_declaration: count('SELECT COUNT(*) n FROM periode_declaration'),
  import_lot: count('SELECT COUNT(*) n FROM import_lot'),
  factures_liees_lot: count('SELECT COUNT(*) n FROM facture WHERE import_lot_id IS NOT NULL'),
  factures_avec_origine: count('SELECT COUNT(*) n FROM facture WHERE annee_origine IS NOT NULL'),
};

console.log('=== RAPPORT DE MIGRATION ===');
console.log('AVANT :', JSON.stringify(report.avant));
console.log('APRÈS :', JSON.stringify(report.apres));
console.log(`Créés → lots: ${report.lots} · périodes: ${report.periodes} · origines factures: ${report.factures_origine}`);
console.log(`Revue doublons → factures 'potentiel' backfillées: ${report.doublons_potentiels || 0}`);
if (report.incertains.length) { console.log('\n⚠️ À vérifier :'); report.incertains.forEach(x => console.log('  - ' + x)); }
else console.log('\n✓ Aucune affectation incertaine.');
// contrôle d'intégrité : le nombre de factures ne doit PAS changer
if (report.avant.factures !== report.apres.factures) { console.error('\n❌ INCOHÉRENCE : le nombre de factures a changé !'); process.exit(1); }
console.log('\n✓ Intégrité : nombre de factures inchangé (' + report.apres.factures + ').');
