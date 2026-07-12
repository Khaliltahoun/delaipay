'use strict';
const XLSX = require('xlsx');
const { db, tauxAt } = require('./db');
const calc = require('./calc');
const { uid, normalizeIce } = require('./util');

/** Normalise un nom de colonne : minuscules, sans accents, sans espaces/ponctuation. */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Synonymes de colonnes → champ interne
const COLMAP = {
  numero: ['num', 'nfacture', 'numero', 'numerofacture', 'nofacture', 'facture'],
  designation: ['des', 'designation', 'nature', 'libelle'],
  mht: ['mht', 'montantht', 'ht'],
  tva: ['tva'],
  ttc: ['ttc', 'montantttc'],
  four_if: ['if', 'iffournisseur', 'iffour'],
  four_ice: ['ice', 'icefournisseur'],
  four_nom: ['nom', 'raisonsociale', 'fournisseur', 'nomfournisseur'],
  taux_tva: ['tx', 'tauxtva', 'taux'],
  mode_reglement: ['id', 'mode', 'modereglement', 'modepaiement'],
  date_paiement: ['dpai', 'datepaiement', 'datereglement', 'paiement'],
  date_facture: ['dfac', 'datefacture', 'dateemission', 'emission'],
  delai_conv: ['convention', 'delaiconvention', 'delaiapplicable'],
  declarant_if: ['identifiantfiscal', 'ifdeclarant'],
};

function buildHeaderIndex(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const n = norm(h);
    for (const [field, syns] of Object.entries(COLMAP)) {
      if (syns.includes(n) && idx[field] === undefined) idx[field] = i;
    }
  });
  return idx;
}

function lookupDelai(entrepriseId, fournisseurId) {
  if (fournisseurId) {
    const conv = db.prepare(
      `SELECT delai_convenu FROM convention
        WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide'
        ORDER BY created_at DESC LIMIT 1`).get(entrepriseId, fournisseurId);
    if (conv) return conv.delai_convenu;
    const f = db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(fournisseurId);
    if (f && f.delai_applicable) return f.delai_applicable;
  }
  return 60;
}

function upsertFournisseur(cabinetId, entrepriseId, { nom, ice, iff }) {
  const iceN = normalizeIce(ice);
  let row = null;
  if (iceN) row = db.prepare('SELECT * FROM fournisseur WHERE entreprise_id=? AND ice=?').get(entrepriseId, iceN);
  if (!row && iff) row = db.prepare('SELECT * FROM fournisseur WHERE entreprise_id=? AND if_fiscal=?').get(entrepriseId, String(iff));
  if (row) {
    // enrichir le nom s'il manque
    if (nom && (!row.raison_sociale || row.raison_sociale.length < String(nom).length)) {
      db.prepare('UPDATE fournisseur SET raison_sociale=? WHERE id=?').run(String(nom), row.id);
    }
    return { id: row.id, created: false };
  }
  const id = uid('four');
  db.prepare(`INSERT INTO fournisseur (id, cabinet_id, entreprise_id, raison_sociale, ice, if_fiscal, delai_applicable)
              VALUES (?,?,?,?,?,?,60)`)
    .run(id, cabinetId, entrepriseId, nom ? String(nom) : null, iceN, iff ? String(iff) : null);
  return { id, created: true };
}

/**
 * Importe un classeur Excel pour une entreprise donnée.
 * @returns {imported, duplicates, fournisseursCreated, anomalies[], totals{}, format}
 */
function importWorkbook(buffer, { cabinetId, entrepriseId, sourceName, periode }) {
  const wb = XLSX.read(buffer, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true });
  if (!grid.length) throw new Error('Fichier vide ou illisible.');

  const header = grid[0];
  const idx = buildHeaderIndex(header);
  if (idx.ttc === undefined && idx.mht === undefined)
    throw new Error("Format non reconnu : colonnes montant (mht/ttc) introuvables.");

  const format = idx.delai_conv !== undefined ? 'DELAI' : 'TVA';
  const importId = uid('imp');
  const today = new Date();
  const result = { imported: 0, duplicates: 0, fournisseursCreated: 0, anomalies: [], format,
    totals: { ttc: 0, aDeclarer: 0, montantTtcRetard: 0, amende: 0 } };

  const addAnomalie = (type, gravite, details, entiteId) => {
    result.anomalies.push({ type, gravite, details });
    db.prepare(`INSERT INTO anomalie (id, cabinet_id, entreprise_id, type, gravite, details, entite, entite_id)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid('ano'), cabinetId, entrepriseId, type, gravite, details, 'facture', entiteId || null);
  };
  const cell = (row, field) => (idx[field] !== undefined ? row[idx[field]] : undefined);

  const insertFacture = db.prepare(`INSERT INTO facture
    (id, cabinet_id, entreprise_id, fournisseur_id, numero, designation, mht, tva, ttc, taux_tva,
     mode_reglement, date_facture, date_paiement, annee, periode, trimestre, source_import, import_id,
     delai_applicable, delai_ecoule, date_limite, retard_jours, n_mois, a_declarer,
     taux_bam, taux_total, base_amende, montant_amende, couleur_risque)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.every(c => c === undefined || c === '')) continue;

    const numero = cell(row, 'numero');
    const mht = num(cell(row, 'mht'));
    const tva = num(cell(row, 'tva'));
    let ttc = num(cell(row, 'ttc'));
    if (!ttc && (mht || tva)) ttc = round2(mht + tva);
    if (!ttc && !numero) continue; // ligne parasite
    // Ignorer les lignes de total / sous-total (aucune identité fournisseur)
    const notEmpty = v => v != null && String(v).trim() !== '';
    const hasSupplier = notEmpty(cell(row, 'four_ice')) || notEmpty(cell(row, 'four_if')) || notEmpty(cell(row, 'four_nom'));
    if (!hasSupplier) continue;

    const dfac = calc.parseDate(cell(row, 'date_facture'));
    const dpai = calc.parseDate(cell(row, 'date_paiement'));
    const four = upsertFournisseur(cabinetId, entrepriseId, {
      nom: cell(row, 'four_nom'), ice: cell(row, 'four_ice'), iff: cell(row, 'four_if'),
    });
    if (four.created) result.fournisseursCreated++;

    // délai applicable
    let delai;
    const convVal = num(cell(row, 'delai_conv'));
    if (format === 'DELAI' && convVal) {
      delai = convVal;
      db.prepare('UPDATE fournisseur SET delai_applicable=? WHERE id=?').run(convVal, four.id);
    } else {
      delai = lookupDelai(entrepriseId, four.id);
    }

    // --- contrôles / anomalies -------------------------------------------------
    if (!dfac) addAnomalie('date_manquante', 'haute', `Facture ${numero || '?'} : date de facture manquante ou illisible.`);
    if (dfac && dpai && dpai < dfac)
      addAnomalie('date_incoherente', 'haute', `Facture ${numero || '?'} : date de paiement (${iso(dpai)}) antérieure à la date de facture (${iso(dfac)}).`);
    if (dfac && dfac > today)
      addAnomalie('date_future', 'haute', `Facture ${numero || '?'} : date de facture dans le futur (${iso(dfac)}).`);
    if (mht && tva && ttc && Math.abs(ttc - (mht + tva)) > 0.5)
      addAnomalie('montant_incoherent', 'moyenne', `Facture ${numero || '?'} : TTC (${ttc}) ≠ HT+TVA (${round2(mht + tva)}).`);

    // doublon
    const dup = db.prepare(`SELECT id FROM facture WHERE entreprise_id=? AND fournisseur_id=? AND numero=? AND ttc=? AND date_facture IS ?`)
      .get(entrepriseId, four.id, numero != null ? String(numero) : null, ttc, iso(dfac));
    if (dup) {
      result.duplicates++;
      addAnomalie('doublon', 'moyenne', `Facture ${numero || '?'} (${result.fmt || ttc}) déjà présente — ignorée.`, dup.id);
      continue;
    }

    // --- calcul -----------------------------------------------------------------
    const per = periode || (dpai ? { annee: dpai.getFullYear(), trimestre: calc.trimestreOf(dpai) }
                                  : (dfac ? { annee: dfac.getFullYear(), trimestre: calc.trimestreOf(dfac) } : null));
    const c = calc.computeFacture({
      dateFacture: dfac, datePaiement: dpai, ttc, delaiApplicable: delai,
      periode: per, today,
      tauxProvider: (y, m) => tauxAt(y, m, cabinetId),
    });

    insertFacture.run(
      uid('fac'), cabinetId, entrepriseId, four.id,
      numero != null ? String(numero) : null,
      cell(row, 'designation') != null ? String(cell(row, 'designation')) : null,
      mht || null, tva || null, ttc || null, num(cell(row, 'taux_tva')) || null,
      cell(row, 'mode_reglement') != null ? String(cell(row, 'mode_reglement')) : null,
      iso(dfac), iso(dpai),
      per ? per.annee : null, per ? per.trimestre : null, per ? per.trimestre : null,
      sourceName || format, importId,
      delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
      c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque
    );
    result.imported++;
    result.totals.ttc = round2(result.totals.ttc + (ttc || 0));
    if (c.aDeclarer) {
      result.totals.aDeclarer++;
      result.totals.montantTtcRetard = round2(result.totals.montantTtcRetard + (ttc || 0));
      result.totals.amende = round2(result.totals.amende + (c.montantAmende || 0));
    }
  }
  return result;
}

function num(v) { if (v == null || v === '') return 0; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? 0 : n; }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function iso(d) { return calc.iso(d); }

module.exports = { importWorkbook };
