'use strict';
/**
 * Contrôle « hors trimestre » de l'assistant d'import — MÊME critère que le moteur pour rattacher une facture
 * à une période (calc.js, en l'absence de période imposée : trimestre de la date de PAIEMENT ; periode.trimestreOfDate) :
 *  - facture payée : elle relève du trimestre de sa date de paiement ;
 *  - facture non payée : elle relève de tout trimestre dont la fin est postérieure ou égale à sa date de facture
 *    (elle y est encore due) — hors période seulement si elle est facturée APRÈS la fin du trimestre.
 * Ne modifie ni periode.js ni importer.js : relit simplement les colonnes mappées du fichier.
 */
const XLSX = require('xlsx');
const calc = require('./calc');
const periode = require('./periode');

/** Rattachement d'UNE ligne au trimestre (annee, trimestre) selon le critère du moteur. */
function lineInPeriod({ dateFacture, datePaiement }, annee, trimestre) {
  const dpai = calc.parseDate(datePaiement), dfac = calc.parseDate(dateFacture);
  if (dpai) return dpai.getFullYear() === +annee && periode.trimestreOfDate(dpai) === +trimestre;
  if (dfac) return dfac <= calc.getFinTrimestre(+annee, +trimestre);
  return true; // ni date de facture ni date de paiement : ligne rejetée par ailleurs, jamais comptée « hors période »
}

/** Compte les lignes (montant TTC positif et au moins une date) dans / hors du trimestre. */
function periodCounts(buffer, { sheetName, headerRow, mapping }, annee, trimestre) {
  const wb = XLSX.read(buffer, { cellDates: true });
  const ws = wb.Sheets[sheetName] || wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: true });
  const m = mapping || {}, col = k => (m[k] == null || m[k] === '' ? null : +m[k]);
  const cFac = col('date_facture'), cPai = col('date_paiement'), cTtc = col('ttc');
  let meme = 0, autre = 0;
  for (let r = (+headerRow || 0) + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const ttc = cTtc == null ? null : Number(row[cTtc]);
    if (!(ttc > 0)) continue;
    const dateFacture = cFac == null ? null : row[cFac], datePaiement = cPai == null ? null : row[cPai];
    if (!calc.parseDate(dateFacture) && !calc.parseDate(datePaiement)) continue;
    if (lineInPeriod({ dateFacture, datePaiement }, annee, trimestre)) meme++; else autre++;
  }
  return { memePeriode: meme, autrePeriode: autre };
}

module.exports = { lineInPeriod, periodCounts };
