'use strict';
const XLSX = require('xlsx');
const { db, tauxAt } = require('./db');
const calc = require('./calc');
const { uid, normalizeIce } = require('./util');

/* ------------------------------------------------------------------ détection colonnes */
// Normalise un libellé d'en-tête : minuscules, sans accents, sans espaces/ponctuation.
function normHead(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
// Concepts ordonnés par priorité. `short` = correspondance EXACTE (tokens courts ambigus).
// `sub` = correspondance par sous-chaîne (libellés longs).
const CONCEPTS = [
  ['declarant_if', { sub: ['identifiantfiscaldeclarant', 'ifdeclarant'] }],       // ignoré (déclarant)
  ['date_paiement', { short: ['dpai', 'datepai', 'datepmt'], sub: ['datepaiement', 'datedepaiement', 'datereglement', 'datedereglement', 'datdereglement', 'datedepmt', 'datepaie', 'datedepaie', 'payele', 'reglele', 'datedecaissement'] }],
  ['date_facture', { short: ['dfac', 'datefact'], sub: ['datefacture', 'datedefacture', 'dateemission', 'datedemission', 'datedelafacture', 'datfacture', 'datedefact', 'emisle', 'datefac'] }],
  ['date_livraison', { sub: ['datelivraison', 'datedelivraison', 'livraison', 'dateexecution', 'dateexec', 'datelivr', 'servicefait'] }],
  ['delai_conv', { sub: ['convention', 'delaiconvenu', 'delaiapplicable', 'delaiconvention', 'delaicontractuel', 'delaiaccorde', 'delailegal'] }],
  ['delai_paiement', { short: ['delai', 'delais', 'jours', 'nbj', 'nbjours'], sub: ['delaidepaiement', 'delaipaiement', 'delaireglement', 'nombredejours', 'nbjours', 'joursdepaiement', 'delaiecoule', 'delaireel'] }],
  ['retard', { short: ['retard'], sub: ['joursderetard', 'nbjoursretard', 'joursretard', 'nombredejoursretard'] }],
  ['mht', { short: ['mht', 'ht'], sub: ['montantht', 'montanthorstaxe', 'baseht', 'totalht', 'montantht'] }],
  ['tva', { short: ['tva'], sub: ['montanttva', 'montantdelatva', 'tvamontant'] }],
  ['ttc', { short: ['ttc', 'montant', 'total'], sub: ['montantttc', 'totalttc', 'montanttoutestaxe', 'montanttoutetaxe', 'montanttotal', 'totaltoutestaxes', 'montantfacturettc', 'montantfacture'] }],
  ['four_ice', { short: ['ice'], sub: ['icefournisseur', 'iceclient', 'identifiantcommun', 'numeroice', 'icetiers'] }],
  ['four_if', { short: ['if', 'nif', 'numif'], sub: ['iffournisseur', 'iffour', 'numeroif', 'identifiantfiscalfournisseur', 'identifiantfiscaltiers'] }],
  ['four_nom', { short: ['nom', 'tiers', 'raisonsociale'], sub: ['raisonsociale', 'nomfournisseur', 'fournisseur', 'beneficiaire', 'denomination', 'nomdufournisseur', 'nomraisonsociale', 'nometprenom'] }],
  ['taux_tva', { short: ['tx', 'taux'], sub: ['tauxtva', 'tauxdetva', 'tauxdetaxe', 'txtva'] }],
  ['mode_reglement', { short: ['id', 'mode'], sub: ['modereglement', 'modepaiement', 'moyenpaiement', 'modedereglement', 'moyendepaiement', 'modedepaiement'] }],
  ['designation', { short: ['des', 'nature', 'objet', 'libelle'], sub: ['designation', 'naturedesmarchandises', 'naturemarchandise', 'libelle', 'description', 'prestation', 'naturecharge', 'marchandise'] }],
  ['numero', { short: ['num', 'numero', 'facture', 'ref', 'piece', 'nfacture', 'reference'], sub: ['numerofacture', 'numfacture', 'nfacture', 'nofacture', 'referencefacture', 'numerodefacture', 'ndefacture', 'numdefacture', 'numfact', 'referencedelafacture', 'nfact', 'numpiece', 'reference'] }],
];
function conceptOf(h) {
  if (!h) return null;
  for (const [f, kw] of CONCEPTS) if (kw.short && kw.short.includes(h)) return f;
  for (const [f, kw] of CONCEPTS) if (kw.sub && h.length >= 3 && kw.sub.some(k => h.includes(k) || (k.length >= 6 && k.includes(h)))) return f;
  return null;
}
function mapRow(row) {
  const idx = {};
  (row || []).forEach((c, i) => { const f = conceptOf(normHead(c)); if (f && f !== 'declarant_if' && idx[f] === undefined) idx[f] = i; });
  return idx;
}
// Repère la meilleure ligne d'en-tête (dans les 25 premières lignes).
function detectHeader(grid) {
  let best = { score: -1, idx: {}, row: 0 };
  const lim = Math.min(grid.length, 25);
  for (let r = 0; r < lim; r++) {
    const idx = mapRow(grid[r]);
    const has = k => idx[k] !== undefined;
    let score = Object.keys(idx).length;
    const montant = has('ttc') || has('mht');
    const date = has('date_facture') || has('date_paiement');
    if (!(montant || date || has('delai_paiement') || has('delai_conv'))) score = 0; // pas un vrai en-tête
    // bonus pour les champs clés demandés
    if (has('numero')) score += 1; if (date) score += 1; if (has('delai_paiement') || has('delai_conv')) score += 1;
    if (score > best.score) best = { score, idx, row: r };
  }
  return best;
}

/* ---------------- détection par le CONTENU (colonnes sans titre) ---------------- */
function isDateVal(v) {
  if (v instanceof Date) return !isNaN(v);
  if (typeof v === 'number') return v >= 40000 && v <= 60000; // série Excel ≈ 2009–2064
  const s = String(v).trim();
  return /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s);
}
function analyzeColumn(grid, startRow, c) {
  const vals = [];
  for (let r = startRow; r < grid.length && vals.length < 60; r++) {
    const v = grid[r] && grid[r][c];
    if (v !== undefined && v !== null && String(v).trim() !== '') vals.push(v);
  }
  if (vals.length < 2) return null;
  let date = 0, ice = 0, idn = 0, amount = 0, numero = 0, text = 0, dateSum = 0, dateN = 0, magSum = 0, magN = 0, anyDecimal = false;
  const lens = [];
  for (const v of vals) {
    const s = String(v).trim();
    const digits = s.replace(/\D/g, '');
    if (isDateVal(v)) { date++; const d = calc.parseDate(v); if (d) { dateSum += d.getTime(); dateN++; } continue; }
    const pureDigits = /^[0-9]+$/.test(s);
    const nv = num(v);
    const hasDec = /[.,]\d/.test(s) || (typeof v === 'number' && !Number.isInteger(v));
    if (hasDec) anyDecimal = true;
    if (pureDigits && digits.length >= 13) ice++;
    else if (pureDigits && digits.length >= 4 && digits.length <= 11 && !hasDec) { idn++; lens.push(digits.length); if (nv) { magSum += nv; magN++; } }
    else if (typeof v === 'number' || /^[\d\s .,\-]+$/.test(s)) { if (nv) { amount++; magSum += Math.abs(nv); magN++; } }
    else if (/[a-z]/i.test(s) && (/\d/.test(s) || /[\/\-]/.test(s)) && s.length <= 26) numero++;
    else text++;
  }
  const n = vals.length, f = x => x / n;
  const avgDate = dateN ? dateSum / dateN : 0, avgMag = magN ? magSum / magN : 0;
  const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  if (f(date) >= 0.6) return { type: 'date', avgDate, avgMag };
  if (f(ice) >= 0.5) return { type: 'ice', avgDate, avgMag };
  if (!anyDecimal && f(idn) >= 0.6 && avgLen >= 5 && avgLen <= 9 && f(amount) < 0.2) return { type: 'if', avgDate, avgMag };
  if (f(amount) + f(idn) >= 0.6 && (anyDecimal || avgMag > 1000)) return { type: 'amount', avgDate, avgMag };
  if (f(numero) >= 0.4) return { type: 'numero', avgDate, avgMag };
  if (f(text) >= 0.5) return { type: 'text', avgDate, avgMag };
  if (f(amount) + f(idn) >= 0.5) return { type: 'amount', avgDate, avgMag };
  return { type: 'text', avgDate, avgMag };
}
// Complète `idx` par l'analyse du contenu, uniquement pour les concepts non déjà repérés par titre.
function inferByContent(grid, startRow, idx) {
  const used = new Set(Object.values(idx));
  const maxCol = grid.reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
  const cols = [];
  for (let c = 0; c < maxCol; c++) { if (used.has(c)) continue; const a = analyzeColumn(grid, startRow, c); if (a) cols.push({ c, ...a }); }
  const dates = [], amounts = [];
  for (const col of cols) {
    if (col.type === 'ice' && idx.four_ice === undefined) { idx.four_ice = col.c; used.add(col.c); }
    else if (col.type === 'if' && idx.four_if === undefined) { idx.four_if = col.c; used.add(col.c); }
    else if (col.type === 'date') dates.push(col);
    else if (col.type === 'amount') amounts.push(col);
    else if (col.type === 'numero' && idx.numero === undefined) { idx.numero = col.c; used.add(col.c); }
  }
  dates.sort((a, b) => a.avgDate - b.avgDate); // facture (plus ancienne) → paiement (plus récente)
  const needFac = idx.date_facture === undefined, needPai = idx.date_paiement === undefined;
  if (dates.length) {
    if (needFac && needPai && dates.length >= 2) { idx.date_facture = dates[0].c; idx.date_paiement = dates[dates.length - 1].c; }
    else if (needFac) idx.date_facture = dates[0].c;
    else if (needPai) idx.date_paiement = dates[dates.length - 1].c;
  }
  amounts.sort((a, b) => b.avgMag - a.avgMag); // plus gros montant → TTC
  for (const col of amounts) {
    if (idx.ttc === undefined) idx.ttc = col.c;
    else if (idx.mht === undefined) idx.mht = col.c;
    else if (idx.tva === undefined) idx.tva = col.c;
  }
  for (const col of cols) if (col.type === 'text') { if (idx.four_nom === undefined) idx.four_nom = col.c; else if (idx.designation === undefined) idx.designation = col.c; }
}

/* ------------------------------------------------------------------ helpers métier */
function lookupDelai(entrepriseId, fournisseurId) {
  if (fournisseurId) {
    const conv = db.prepare(`SELECT delai_convenu FROM convention WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide' ORDER BY created_at DESC LIMIT 1`).get(entrepriseId, fournisseurId);
    if (conv) return conv.delai_convenu;
    const f = db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(fournisseurId);
    if (f && f.delai_applicable) return f.delai_applicable;
  }
  return 60;
}
function hasValidConvention(entrepriseId, fournisseurId) {
  if (!fournisseurId) return false;
  return !!db.prepare(`SELECT 1 FROM convention WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide' LIMIT 1`).get(entrepriseId, fournisseurId);
}
function upsertFournisseur(cabinetId, entrepriseId, { nom, ice, iff }) {
  const iceN = normalizeIce(ice);
  let row = null;
  if (iceN) row = db.prepare('SELECT * FROM fournisseur WHERE entreprise_id=? AND ice=?').get(entrepriseId, iceN);
  if (!row && iff) row = db.prepare('SELECT * FROM fournisseur WHERE entreprise_id=? AND if_fiscal=?').get(entrepriseId, String(iff));
  if (!row && !iceN && !iff && nom) row = db.prepare('SELECT * FROM fournisseur WHERE entreprise_id=? AND raison_sociale=?').get(entrepriseId, String(nom));
  if (row) {
    if (nom && (!row.raison_sociale || row.raison_sociale.length < String(nom).length))
      db.prepare('UPDATE fournisseur SET raison_sociale=? WHERE id=?').run(String(nom), row.id);
    return { id: row.id, created: false };
  }
  const id = uid('four');
  db.prepare(`INSERT INTO fournisseur (id, cabinet_id, entreprise_id, raison_sociale, ice, if_fiscal, delai_applicable) VALUES (?,?,?,?,?,?,60)`)
    .run(id, cabinetId, entrepriseId, nom ? String(nom) : null, iceN, iff ? String(iff) : null);
  return { id, created: true };
}

/* ------------------------------------------------------------------ import */
function importWorkbook(buffer, { cabinetId, entrepriseId, sourceName, periode }) {
  const wb = XLSX.read(buffer, { cellDates: true });
  // Choisit la feuille et la ligne d'en-tête offrant la meilleure détection.
  let chosen = null;
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: true });
    if (!grid.length) continue;
    const det = detectHeader(grid);
    if (!chosen || det.score > chosen.det.score) chosen = { name, grid, det };
  }
  if (!chosen) throw new Error("Fichier vide ou illisible.");
  const { grid, det } = chosen;
  let idx = det.idx, startRow = det.row + 1;
  if (det.score < 2) {
    // En-tête non fiable → décider s'il y a un en-tête, puis inférer depuis le contenu.
    const row0 = grid[0] || [];
    const looksData = row0.filter(c => isDateVal(c) || String(c).replace(/\D/g, '').length >= 4).length >= 2;
    startRow = looksData ? 0 : 1;
    idx = looksData ? {} : mapRow(grid[0]);
  }
  inferByContent(grid, startRow, idx); // complète les colonnes sans titre
  if (idx.ttc === undefined && idx.mht === undefined && idx.date_facture === undefined && idx.date_paiement === undefined && idx.delai_paiement === undefined)
    throw new Error("Colonnes non reconnues : ni montant ni dates détectés (même par analyse du contenu).");
  const cell = (row, field) => (idx[field] !== undefined ? row[idx[field]] : undefined);
  const format = idx.delai_conv !== undefined ? 'DELAI' : 'TVA';
  const importId = uid('imp');
  const today = new Date();

  const result = {
    importId, imported: 0, duplicates: 0, fournisseursCreated: 0, anomalies: [], format,
    colonnes: Object.keys(idx), feuille: chosen.name, ligneEntete: det.row + 1,
    totals: { ttc: 0, aDeclarer: 0, montantTtcRetard: 0, amende: 0, convAbsente: 0 },
  };
  const addAnomalie = (type, gravite, details, entiteId) => {
    result.anomalies.push({ type, gravite, details });
    db.prepare(`INSERT INTO anomalie (id, cabinet_id, entreprise_id, type, gravite, details, entite, entite_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid('ano'), cabinetId, entrepriseId, type, gravite, details, 'facture', entiteId || null);
  };
  const insertFacture = db.prepare(`INSERT INTO facture
    (id, cabinet_id, entreprise_id, fournisseur_id, numero, designation, mht, tva, ttc, taux_tva, mode_reglement,
     date_facture, date_paiement, annee, periode, trimestre, source_import, import_id,
     delai_applicable, delai_ecoule, date_limite, retard_jours, n_mois, a_declarer,
     taux_bam, taux_total, base_amende, montant_amende, couleur_risque)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  for (let r = startRow; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.every(c => c === undefined || c === '')) continue;

    const numero = cell(row, 'numero');
    const mht = num(cell(row, 'mht'));
    const tva = num(cell(row, 'tva'));
    let ttc = num(cell(row, 'ttc'));
    if (!ttc && (mht || tva)) ttc = round2(mht + tva);
    if (!ttc && !numero) continue;
    const notEmpty = v => v != null && String(v).trim() !== '';
    const hasSupplier = notEmpty(cell(row, 'four_ice')) || notEmpty(cell(row, 'four_if')) || notEmpty(cell(row, 'four_nom'));
    if (!hasSupplier) continue; // ligne de total / parasite

    const dfac = calc.parseDate(cell(row, 'date_facture'));
    let dpai = calc.parseDate(cell(row, 'date_paiement'));
    const delaiPaie = num(cell(row, 'delai_paiement'));
    // Fichier « délais de paiement » sans date de paiement mais avec un délai en jours → on dérive la date.
    if (!dpai && dfac && delaiPaie > 0) dpai = calc.addDays(dfac, Math.round(delaiPaie));

    const four = upsertFournisseur(cabinetId, entrepriseId, { nom: cell(row, 'four_nom'), ice: cell(row, 'four_ice'), iff: cell(row, 'four_if') });
    if (four.created) result.fournisseursCreated++;

    let delai;
    const convVal = num(cell(row, 'delai_conv'));
    if (format === 'DELAI' && convVal) { delai = convVal; db.prepare('UPDATE fournisseur SET delai_applicable=? WHERE id=?').run(convVal, four.id); }
    else delai = lookupDelai(entrepriseId, four.id);

    // contrôles
    const nfx = numero != null ? String(numero) : '?';
    if (!dfac) addAnomalie('date_manquante', 'haute', `Facture ${nfx} : date de facture manquante ou illisible.`);
    if (dfac && dpai && dpai < dfac) addAnomalie('date_incoherente', 'haute', `Facture ${nfx} : date de paiement (${iso(dpai)}) antérieure à la date de facture (${iso(dfac)}).`);
    if (dfac && dfac > today) addAnomalie('date_future', 'haute', `Facture ${nfx} : date de facture dans le futur (${iso(dfac)}).`);
    if (mht && tva && ttc && Math.abs(ttc - (mht + tva)) > 0.5) addAnomalie('montant_incoherent', 'moyenne', `Facture ${nfx} : TTC (${ttc}) ≠ HT+TVA (${round2(mht + tva)}).`);

    const dup = db.prepare(`SELECT id FROM facture WHERE entreprise_id=? AND fournisseur_id=? AND numero IS ? AND ttc=? AND date_facture IS ?`)
      .get(entrepriseId, four.id, numero != null ? String(numero) : null, ttc, iso(dfac));
    if (dup) { result.duplicates++; addAnomalie('doublon', 'moyenne', `Facture ${nfx} (${ttc}) déjà présente — ignorée.`, dup.id); continue; }

    const per = periode || (dpai ? { annee: dpai.getFullYear(), trimestre: calc.trimestreOf(dpai) } : (dfac ? { annee: dfac.getFullYear(), trimestre: calc.trimestreOf(dfac) } : null));
    const c = calc.computeFacture({ dateFacture: dfac, datePaiement: dpai, ttc, delaiApplicable: delai, periode: per, today, tauxProvider: (y, m) => tauxAt(y, m, cabinetId) });

    // Question métier : délai > 60 j → convention disponible avec le fournisseur ?
    if (c.delaiEcoule != null && c.delaiEcoule > 60 && !hasValidConvention(entrepriseId, four.id)) {
      result.totals.convAbsente++;
      addAnomalie('convention_absente', 'moyenne', `Facture ${nfx} : délai de ${c.delaiEcoule} j (> 60 j) SANS convention enregistrée pour le fournisseur ${cell(row, 'four_nom') || four.id}.`, four.id);
    }

    insertFacture.run(uid('fac'), cabinetId, entrepriseId, four.id, numero != null ? String(numero) : null,
      cell(row, 'designation') != null ? String(cell(row, 'designation')) : null,
      mht || null, tva || null, ttc || null, num(cell(row, 'taux_tva')) || null,
      cell(row, 'mode_reglement') != null ? String(cell(row, 'mode_reglement')) : null,
      iso(dfac), iso(dpai), per ? per.annee : null, per ? per.trimestre : null, per ? per.trimestre : null,
      sourceName || format, importId,
      delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
      c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque);
    result.imported++;
    result.totals.ttc = round2(result.totals.ttc + (ttc || 0));
    if (c.aDeclarer) { result.totals.aDeclarer++; result.totals.montantTtcRetard = round2(result.totals.montantTtcRetard + (ttc || 0)); result.totals.amende = round2(result.totals.amende + (c.montantAmende || 0)); }
  }
  if (result.imported === 0 && result.duplicates === 0)
    throw new Error("Aucune ligne de facture exploitable détectée (vérifiez que le fichier contient des fournisseurs et des montants).");
  return result;
}

function num(v) { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[\s ]/g, '').replace(',', '.').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function iso(d) { return calc.iso(d); }

module.exports = { importWorkbook, detectHeader, normHead };
