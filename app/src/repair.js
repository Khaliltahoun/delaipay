'use strict';
/**
 * Réparation des délais applicables corrompus (idempotent, transactionnel).
 *
 * Contexte : d'anciens imports ont pu stocker des délais aberrants (ex. « 60 120 »
 * concaténé → 60120, ou une date/ICE prise pour un délai). Un délai applicable > 120 j
 * masque des retards RÉELS (retard = délai écoulé − délai applicable → négatif → 0 amende).
 *
 * Ce script :
 *  1. plafonne convention.delai_convenu et fournisseur.delai_applicable à [1, 120] j ;
 *  2. RECALCULE toutes les périodes (délai borné par le moteur) → retards/amendes corrigés ;
 *  3. ne touche RIEN d'autre (montants, dates, PDF, conventions valides).
 *
 * Lancer :  npm run repair-delais      (ou  DB_PATH=… node src/repair.js)
 * Sûr à relancer : les valeurs déjà saines ne sont pas modifiées.
 */
const { db, tauxAt } = require('./db');
const calc = require('./calc');

function repair() {
  const stats = { conventionsPlafonnees: 0, fournisseursPlafonnes: 0, facturesRecalculees: 0, periodes: 0 };
  db.exec('BEGIN');
  try {
    // 1) Conventions : délai convenu ramené à [1, 120] (défaut 120 si illisible sur une convention).
    for (const c of db.prepare('SELECT id, delai_convenu FROM convention').all()) {
      const s = calc.saneDelai(c.delai_convenu, 120);
      if (s !== c.delai_convenu) { db.prepare('UPDATE convention SET delai_convenu=? WHERE id=?').run(s, c.id); stats.conventionsPlafonnees++; }
    }
    // 2) Fournisseurs : délai applicable ramené à [1, 120] (défaut légal 60 si illisible).
    for (const f of db.prepare('SELECT id, delai_applicable FROM fournisseur').all()) {
      const s = calc.saneDelai(f.delai_applicable, 60);
      if (s !== f.delai_applicable) { db.prepare('UPDATE fournisseur SET delai_applicable=? WHERE id=?').run(s, f.id); stats.fournisseursPlafonnes++; }
    }
    // 3) Recalcul de toutes les périodes avec le moteur corrigé (délai borné à 120 j).
    const upd = db.prepare(`UPDATE facture SET delai_applicable=?, delai_ecoule=?, date_limite=?, retard_jours=?,
      n_mois=?, a_declarer=?, taux_bam=?, taux_total=?, base_amende=?, montant_amende=?, couleur_risque=? WHERE id=?`);
    const groups = db.prepare(`SELECT DISTINCT cabinet_id, entreprise_id, annee, trimestre FROM facture
                               WHERE annee IS NOT NULL AND trimestre IS NOT NULL`).all();
    for (const g of groups) {
      const rows = db.prepare('SELECT * FROM facture WHERE entreprise_id=? AND annee=? AND trimestre=?').all(g.entreprise_id, g.annee, g.trimestre);
      for (const f of rows) {
        const conv = db.prepare(`SELECT delai_convenu FROM convention WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide' ORDER BY created_at DESC LIMIT 1`).get(g.entreprise_id, f.fournisseur_id);
        const fr = db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(f.fournisseur_id);
        const delai = calc.saneDelai(conv ? conv.delai_convenu : (fr && fr.delai_applicable ? fr.delai_applicable : f.delai_applicable));
        const c = calc.computeFacture({ dateFacture: f.date_facture, datePaiement: f.date_paiement, ttc: f.ttc,
          delaiApplicable: delai, periode: { annee: g.annee, trimestre: g.trimestre }, tauxProvider: (y, m) => tauxAt(y, m, g.cabinet_id) });
        upd.run(delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
          c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque, f.id);
        stats.facturesRecalculees++;
      }
      stats.periodes++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return stats;
}

if (require.main === module) {
  const r = repair();
  console.log(`Réparation délais terminée : ${r.conventionsPlafonnees} convention(s) et ${r.fournisseursPlafonnes} fournisseur(s) plafonné(s) à 120 j ; ${r.facturesRecalculees} facture(s) recalculée(s) sur ${r.periodes} période(s).`);
}
module.exports = { repair };
