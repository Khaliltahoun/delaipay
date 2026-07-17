'use strict';
const XLSX = require('xlsx');
const xmljs = require('xml-js');
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
  ['ttc', { short: ['ttc', 'montant', 'total'], sub: ['montantttc', 'totalttc', 'montanttoutestaxe', 'montanttoutetaxe', 'montanttotal', 'totaltoutestaxes', 'montantfacturettc', 'montantfacture', 'montantdelafacture', 'montantdela facture', 'montantfact'] }],
  ['four_ice', { short: ['ice'], sub: ['icefournisseur', 'iceclient', 'identifiantcommun', 'numeroice', 'icetiers'] }],
  ['four_if', { short: ['if', 'nif', 'numif'], sub: ['iffournisseur', 'iffour', 'numeroif', 'identifiantfiscalfournisseur', 'identifiantfiscaltiers'] }],
  ['four_nom', { short: ['nom', 'tiers', 'raisonsociale'], sub: ['raisonsociale', 'nomfournisseur', 'fournisseur', 'beneficiaire', 'denomination', 'nomdufournisseur', 'nomraisonsociale', 'nometprenom'] }],
  ['taux_tva', { short: ['tx', 'taux'], sub: ['tauxtva', 'tauxdetva', 'tauxdetaxe', 'txtva'] }],
  ['mode_reglement', { short: ['id', 'mode'], sub: ['modereglement', 'modepaiement', 'moyenpaiement', 'modedereglement', 'moyendepaiement', 'modedepaiement'] }],
  ['designation', { short: ['des', 'nature', 'objet', 'libelle'], sub: ['designation', 'naturedesmarchandises', 'naturemarchandise', 'libelle', 'description', 'prestation', 'naturecharge', 'marchandise'] }],
  ['numero', { short: ['num', 'numero', 'facture', 'facturen', 'ref', 'piece', 'nfacture', 'nfact', 'factn', 'nofacture', 'ndefacture', 'reference', 'n', 'no', 'ndf'], sub: ['numerofacture', 'numfacture', 'nfacture', 'nofacture', 'referencefacture', 'numerodefacture', 'ndefacture', 'numdefacture', 'numfact', 'facturen', 'referencedelafacture', 'nfact', 'numpiece', 'reference'] }],
];
function conceptOf(h) {
  if (!h) return null;
  for (const [f, kw] of CONCEPTS) if (kw.short && kw.short.includes(h)) return f;
  for (const [f, kw] of CONCEPTS) if (kw.sub && h.length >= 3 && kw.sub.some(k => h.includes(k) || (h.length >= 6 && k.length > h.length && k.startsWith(h)))) return f;
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
    if (pureDigits && !hasDec && digits.length >= 13) ice++;
    else if (pureDigits && !hasDec && digits.length >= 10) ice++;                    // identifiant long (compte / ICE tronqué) — jamais un montant
    else if (pureDigits && !hasDec && digits.length >= 4 && digits.length <= 9) { idn++; lens.push(digits.length); }
    else if ((typeof v === 'number' || /^[\d\s .,\-]+$/.test(s)) && nv) {
      if (Math.abs(nv) < 5e8) { amount++; magSum += Math.abs(nv); magN++; }         // montant plausible
      else ice++;                                                                    // trop grand pour un montant → identifiant
    }
    else if (/[a-z]/i.test(s) && (/\d/.test(s) || /[\/\-]/.test(s)) && s.length <= 26) numero++;
    else text++;
  }
  const n = vals.length, f = x => x / n;
  const avgDate = dateN ? dateSum / dateN : 0, avgMag = magN ? magSum / magN : 0;
  const avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  if (f(date) >= 0.6) return { type: 'date', avgDate, avgMag };
  if (f(ice) >= 0.5) return { type: 'ice', avgDate, avgMag };
  if (!anyDecimal && f(idn) >= 0.6 && avgLen >= 5 && avgLen <= 9 && f(amount) < 0.2) return { type: 'if', avgDate, avgMag };
  if (f(amount) >= 0.5 && (anyDecimal || avgMag > 100)) return { type: 'amount', avgDate, avgMag };
  if (f(numero) >= 0.4) return { type: 'numero', avgDate, avgMag };
  if (f(text) >= 0.5) return { type: 'text', avgDate, avgMag };
  if (f(amount) >= 0.4 && avgMag > 0) return { type: 'amount', avgDate, avgMag };
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
// Résout, pour une grille, la ligne d'en-tête + l'index des colonnes (titre puis contenu).
function resolveSheet(grid) {
  const det = detectHeader(grid);
  let idx = det.idx, startRow = det.row + 1;
  if (det.score < 2) {
    // En-tête non fiable → décider s'il y a un en-tête, puis inférer depuis le contenu.
    const row0 = grid[0] || [];
    const looksData = row0.filter(c => isDateVal(c) || String(c).replace(/\D/g, '').length >= 4).length >= 2;
    startRow = looksData ? 0 : 1;
    idx = looksData ? {} : mapRow(grid[0]);
  }
  inferByContent(grid, startRow, idx); // complète les colonnes sans titre
  const importable = idx.ttc !== undefined || idx.mht !== undefined || idx.date_facture !== undefined || idx.date_paiement !== undefined || idx.delai_paiement !== undefined;
  return { idx, startRow, score: det.score, ligneEntete: det.row + 1, importable };
}

function importWorkbook(buffer, opts) {
  // Relevé de déductions SIMPL au format XML officiel (<DeclarationReleveDeduction>) → parseur dédié.
  const head = buffer.slice(0, 400).toString('utf8');
  if (/^﻿?\s*<\?xml/.test(head) && /DeclarationReleveDeduction|releveDeductions/.test(buffer.toString('utf8', 0, 2000)))
    return importReleveXml(buffer, opts);
  return importExcel(buffer, opts);
}

/* Relevé de déductions TVA (SIMPL) — 1 <rd> = 1 facture. Données propres et normalisées. */
function importReleveXml(buffer, { cabinetId, entrepriseId, sourceName, periode }) {
  const root = (xmljs.xml2js(buffer.toString('utf8'), { compact: true }) || {}).DeclarationReleveDeduction;
  if (!root) throw new Error('XML non reconnu (DeclarationReleveDeduction attendu).');
  const T = x => (x && x._text !== undefined ? String(x._text).trim() : null);
  let rd = root.releveDeductions && root.releveDeductions.rd;
  rd = !rd ? [] : (Array.isArray(rd) ? rd : [rd]);
  const importId = uid('imp');
  const today = new Date();
  const result = {
    importId, imported: 0, duplicates: 0, fournisseursCreated: 0, anomalies: [], format: 'RELEVE_XML',
    colonnes: ['numero', 'designation', 'mht', 'tva', 'ttc', 'four_if', 'four_nom', 'four_ice', 'date_facture', 'date_paiement'],
    feuilles: ['releveDeductions'], feuille: 'releveDeductions', ligneEntete: 0,
    totals: { ttc: 0, aDeclarer: 0, montantTtcRetard: 0, amende: 0, convAbsente: 0 },
  };
  const insertFacture = db.prepare(`INSERT INTO facture
    (id, cabinet_id, entreprise_id, fournisseur_id, numero, designation, mht, tva, ttc, taux_tva, mode_reglement,
     date_facture, date_paiement, annee, periode, trimestre, source_import, import_id,
     delai_applicable, delai_ecoule, date_limite, retard_jours, n_mois, a_declarer,
     taux_bam, taux_total, base_amende, montant_amende, couleur_risque)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const x of rd) {
    const ref = x.refF || {};
    const nom = T(ref.nom), ice = T(ref.ice), iff = T(ref.if);
    let ttc = num(T(x.ttc)); const mht = num(T(x.mht)), tva = num(T(x.tva));
    if (!ttc && (mht || tva)) ttc = round2(mht + tva);
    if (Math.abs(ttc) >= 5e8) continue;
    if (!nom && !ice && !iff) continue;
    const sane = d => (d && d.getFullYear() >= 2000 && d.getFullYear() <= 2035) ? d : null;
    const dfac = sane(calc.parseDate(T(x.dfac)));
    const dpai = sane(calc.parseDate(T(x.dpai)));
    if (!(ttc || dfac || dpai)) continue;
    const four = upsertFournisseur(cabinetId, entrepriseId, { nom, ice, iff });
    if (four.created) result.fournisseursCreated++;
    const delai = lookupDelai(entrepriseId, four.id);
    const numero = T(x.num);
    const dup = db.prepare(`SELECT id FROM facture WHERE entreprise_id=? AND fournisseur_id=? AND numero IS ? AND ttc=? AND date_facture IS ?`)
      .get(entrepriseId, four.id, numero, ttc, iso(dfac));
    if (dup) { result.duplicates++; continue; }
    const per = periode || (dpai ? { annee: dpai.getFullYear(), trimestre: calc.trimestreOf(dpai) } : (dfac ? { annee: dfac.getFullYear(), trimestre: calc.trimestreOf(dfac) } : null));
    const c = calc.computeFacture({ dateFacture: dfac, datePaiement: dpai, ttc, delaiApplicable: delai, periode: per, today, tauxProvider: (y, m) => tauxAt(y, m, cabinetId) });
    if (c.delaiEcoule != null && c.delaiEcoule > 60 && !hasValidConvention(entrepriseId, four.id)) {
      result.totals.convAbsente++;
      db.prepare(`INSERT INTO anomalie (id, cabinet_id, entreprise_id, type, gravite, details, entite, entite_id) VALUES (?,?,?,?,?,?,?,?)`)
        .run(uid('ano'), cabinetId, entrepriseId, 'convention_absente', 'moyenne', `Facture ${numero || '?'} : délai de ${c.delaiEcoule} j (> 60 j) SANS convention pour ${nom || four.id}.`, 'facture', four.id);
    }
    insertFacture.run(uid('fac'), cabinetId, entrepriseId, four.id, numero,
      T(x.des), mht || null, tva || null, ttc || null, num(T(x.tx)) || null, T(x.mp && x.mp.id),
      iso(dfac), iso(dpai), per ? per.annee : null, per ? per.trimestre : null, per ? per.trimestre : null,
      sourceName || 'RELEVE_XML', importId,
      delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
      c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque);
    result.imported++;
    result.totals.ttc = round2(result.totals.ttc + (ttc || 0));
    if (c.aDeclarer) { result.totals.aDeclarer++; result.totals.montantTtcRetard = round2(result.totals.montantTtcRetard + (ttc || 0)); result.totals.amende = round2(result.totals.amende + (c.montantAmende || 0)); }
  }
  if (result.imported === 0 && result.duplicates === 0) throw new Error('Relevé XML sans ligne exploitable.');
  return result;
}

// Feuilles écartées : grand-livre / journal / balance (numéros de compte pris pour des montants).
const SHEET_SKIP = /grand.?livre|journal|balance|brouillard|lettrage|^gl\b|\bg\.?l\b|grd livre/i;

function importExcel(buffer, { cabinetId, entrepriseId, sourceName, periode }) {
  const wb = XLSX.read(buffer, { cellDates: true });
  // On traite TOUTES les feuilles ressemblant à un tableau de factures (pas seulement la meilleure).
  const sheets = [];
  for (const name of wb.SheetNames) {
    if (SHEET_SKIP.test(name)) continue;
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: true });
    if (!grid.length) continue;
    const r = resolveSheet(grid);
    if (r.importable) sheets.push({ name, grid, ...r });
  }
  if (!sheets.length) throw new Error("Colonnes non reconnues : ni montant ni dates détectés (même par analyse du contenu).");

  const importId = uid('imp');
  const today = new Date();
  const fileFormat = sheets.some(s => s.idx.delai_conv !== undefined) ? 'DELAI' : 'TVA';
  const result = {
    importId, imported: 0, duplicates: 0, fournisseursCreated: 0, anomalies: [], format: fileFormat,
    colonnes: [...new Set(sheets.flatMap(s => Object.keys(s.idx)))],
    feuilles: sheets.map(s => `${s.name} (L${s.ligneEntete})`), feuille: sheets[0].name, ligneEntete: sheets[0].ligneEntete,
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

  for (const sheet of sheets) processSheet(sheet);
  if (result.imported === 0 && result.duplicates === 0)
    throw new Error("Aucune ligne de facture exploitable détectée (vérifiez que le fichier contient des fournisseurs et des montants).");
  return result;

  function processSheet({ grid, idx, startRow }) {
    const format = idx.delai_conv !== undefined ? 'DELAI' : 'TVA';
    const cell = (row, field) => (idx[field] !== undefined ? row[idx[field]] : undefined);
    for (let r = startRow; r < grid.length; r++) {
      const row = grid[r];
      if (!row || row.every(c => c === undefined || c === '')) continue;

      const numero = cell(row, 'numero');
      const mht = num(cell(row, 'mht'));
      const tva = num(cell(row, 'tva'));
      let ttc = num(cell(row, 'ttc'));
      if (!ttc && (mht || tva)) ttc = round2(mht + tva);
      if (!ttc && !numero) continue;
      // Garde-fou montant : au-delà de 500 M DH c'est une valeur parasite (n° de compte, série, cellule concaténée).
      if (Math.abs(ttc) >= 5e8 || Math.abs(mht) >= 5e8 || Math.abs(tva) >= 5e8) continue;
      const notEmpty = v => v != null && String(v).trim() !== '';
      const hasSupplier = notEmpty(cell(row, 'four_ice')) || notEmpty(cell(row, 'four_if')) || notEmpty(cell(row, 'four_nom'));
      if (!hasSupplier) continue; // ligne de total / parasite

      // Garde-fou date : on rejette les années aberrantes (séries Excel prises pour des dates → 1899, 2536…).
      const sane = d => (d && d.getFullYear() >= 2000 && d.getFullYear() <= 2035) ? d : null;
      const dfac = sane(calc.parseDate(cell(row, 'date_facture')));
      let dpai = sane(calc.parseDate(cell(row, 'date_paiement')));
      const delaiPaie = num(cell(row, 'delai_paiement'));
      // Fichier « délais de paiement » sans date de paiement mais avec un délai en jours → on dérive la date.
      if (!dpai && dfac && delaiPaie > 0) dpai = calc.addDays(dfac, Math.round(delaiPaie));

      // Rejet des lignes d'en-tête / libellés qui fuient comme données : une vraie facture a un montant OU une date.
      if (!(ttc > 0 || mht !== 0 || tva !== 0 || dfac || dpai || delaiPaie > 0)) continue;

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
  }
}

function num(v) { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[\s ]/g, '').replace(',', '.').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function iso(d) { return calc.iso(d); }

/* ================================================================================
 * ASSISTANT D'IMPORT — analyse, mapping, prévisualisation, confirmation
 * ================================================================================ */

// Champs canoniques DelaiPay (clé, libellé, requis).
const FIELDS = [
  ['numero', 'N° de facture', false],
  ['date_facture', 'Date de facture', true],
  ['four_nom', 'Fournisseur', true],
  ['four_ice', 'ICE fournisseur', false],
  ['four_if', 'IF fournisseur', false],
  ['ttc', 'Montant TTC', true],
  ['mht', 'Montant HT', false],
  ['tva', 'Montant TVA', false],
  ['taux_tva', 'Taux TVA', false],
  ['date_paiement', 'Date de paiement', false],
  ['mode_reglement', 'Mode de paiement', false],
  ['designation', 'Nature / désignation', false],
  ['delai_conv', 'Délai convenu', false],
];
const FIELD_KEYS = FIELDS.map(f => f[0]);

// Lignes à ignorer : total, sous-total, report, cumul, solde… (insensible casse/accents/espaces).
const IGNORE_WORDS = new Set(['total', 'totalgeneral', 'totaux', 'soustotal', 'sstotal', 'stotal', 'report', 'areporter', 'reporter', 'cumul', 'cumule', 'solde', 'balance', 'arrete', 'arretes', 'sommetotale', 'grandtotal', 'montanttotal']);
function normCell(v) { return String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }
function isFormulaTotal(v) { const s = String(v == null ? '' : v); return /^=/.test(s) || /\b(sum|subtotal)\b/i.test(s) || /sous.?total/i.test(s); }
// Examine PLUSIEURS cellules de la ligne, pas seulement la première.
function classifyIgnorable(cells, headerNorms) {
  const nonEmpty = cells.filter(c => c != null && String(c).trim() !== '');
  if (!nonEmpty.length) return { ignore: true, motif: 'ligne vide' };
  for (const c of cells) if (isFormulaTotal(c)) return { ignore: true, motif: 'formule de total (SUM/SOUS-TOTAL)' };
  for (const c of nonEmpty) { const n = normCell(c); if (n && IGNORE_WORDS.has(n)) return { ignore: true, motif: `ligne de total/sous-total ("${String(c).trim()}")` }; }
  if (headerNorms && headerNorms.length) {
    const norms = cells.map(normCell).filter(Boolean);
    const match = norms.filter(n => headerNorms.includes(n)).length;
    if (norms.length && match >= Math.max(2, Math.ceil(norms.length * 0.6))) return { ignore: true, motif: 'répétition de l\'en-tête' };
  }
  return { ignore: false };
}

// Mapping automatique (titre prioritaire, puis contenu) avec niveau de confiance.
function autoMapGrid(grid) {
  const det = detectHeader(grid);
  const headerRow = det.row;
  const titleIdx = mapRow(grid[headerRow] || []);
  const resolved = resolveSheet(grid);
  const mapping = {};
  for (const [f, col] of Object.entries(resolved.idx)) {
    if (!FIELD_KEYS.includes(f)) continue;
    const fromTitle = titleIdx[f] !== undefined;
    mapping[f] = { col, confidence: fromTitle ? 0.92 : 0.6, source: fromTitle ? 'titre' : 'contenu' };
  }
  return { headerRow, startRow: resolved.startRow, mapping };
}
function sampleValues(grid, startRow, col, n = 8) {
  const out = [];
  for (let r = startRow; r < grid.length && out.length < n; r++) {
    const v = grid[r] && grid[r][col];
    if (v !== undefined && v !== null && String(v).trim() !== '') out.push(v instanceof Date ? calc.iso(v) : String(v).slice(0, 30));
  }
  return out;
}

// Analyse d'un classeur : feuilles, colonnes, échantillon, mapping proposé, feuille suggérée.
function analyzeWorkbook(buffer) {
  const head = buffer.slice(0, 400).toString('utf8');
  if (/^﻿?\s*<\?xml/.test(head) && /DeclarationReleveDeduction|releveDeductions/.test(buffer.toString('utf8', 0, 2000))) {
    return { type: 'RELEVE_XML', feuilles: [], suggestion: null, xml: true, champs: FIELDS.map(([k, l, r]) => ({ key: k, label: l, requis: r })) };
  }
  const wb = XLSX.read(buffer, { cellDates: true });
  const feuilles = [];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: true });
    if (!grid.length) continue;
    const am = autoMapGrid(grid);
    const cols = (grid[am.headerRow] || []).map((c, i) => ({ index: i, label: String(c == null ? '' : c).replace(/\s+/g, ' ').trim() || `Colonne ${i + 1}` }));
    const maxCol = grid.reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
    for (let i = cols.length; i < maxCol; i++) cols.push({ index: i, label: `Colonne ${i + 1}` });
    const mapping = {};
    for (const [f, m] of Object.entries(am.mapping)) mapping[f] = { ...m, colLabel: (cols[m.col] || {}).label || '', apercu: sampleValues(grid, am.startRow, m.col) };
    feuilles.push({
      nom: name, nbLignes: grid.length, ligneEntete: am.headerRow, startRow: am.startRow,
      ignoree: SHEET_SKIP.test(name), colonnes: cols,
      echantillon: grid.slice(am.startRow, am.startRow + 6).map(r => cols.map(c => { const v = r ? r[c.index] : ''; return v instanceof Date ? calc.iso(v) : (v == null ? '' : String(v).slice(0, 24)); })),
      mapping,
    });
  }
  const candidates = feuilles.filter(f => !f.ignoree);
  const suggestion = (candidates.length ? candidates : feuilles).map(f => ({ f, s: Object.keys(f.mapping).length + (f.mapping.ttc ? 2 : 0) + (f.mapping.date_facture ? 1 : 0) })).sort((a, b) => b.s - a.s)[0];
  return { type: 'EXCEL', feuilles, suggestion: suggestion ? suggestion.f.nom : (feuilles[0] && feuilles[0].nom), champs: FIELDS.map(([k, l, r]) => ({ key: k, label: l, requis: r })) };
}

function fingerprint(entrepriseId, nom, numero, dfacIso, ttc) {
  const fnom = normCell(nom);
  const fnum = String(numero == null ? '' : numero).toLowerCase().replace(/^0+/, '').replace(/[^a-z0-9]/g, '');
  return [entrepriseId, fnom, fnum, dfacIso || '', Math.round((Number(ttc) || 0) * 100)].join('|');
}

/** Classe les lignes selon un mapping explicite, SANS écrire en base. */
function classifyGrid(grid, { headerRow, mapping, entrepriseId, annee, trimestre, requireNumero = false }) {
  const col = f => (mapping[f] != null && mapping[f] !== '' ? Number(mapping[f]) : undefined);
  const cell = (row, f) => { const c = col(f); return c != null ? row[c] : undefined; };
  const headerNorms = (grid[headerRow] || []).map(normCell).filter(Boolean);
  const sane = d => (d && d.getFullYear() >= 2000 && d.getFullYear() <= 2035) ? d : null;
  const notEmpty = v => v != null && String(v).trim() !== '';
  const seen = new Set();
  const lignes = [];
  const stats = { total: 0, valides: 0, ignorees: 0, rejetees: 0, doublons: 0, totalTtc: 0, avertissements: 0, memePeriode: 0, autrePeriode: 0 };
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    stats.total++;
    const brut = row.map(v => v instanceof Date ? calc.iso(v) : (v == null ? '' : String(v)));
    const ig = classifyIgnorable(row, headerNorms);
    if (ig.ignore) { stats.ignorees++; lignes.push({ ligne: r + 1, statut: 'ignoree', motif: ig.motif, brut }); continue; }

    const nom = cell(row, 'four_nom'), ice = normalizeIce(cell(row, 'four_ice')), iff = cell(row, 'four_if');
    const mht = num(cell(row, 'mht')), tva = num(cell(row, 'tva'));
    let ttc = num(cell(row, 'ttc')); if (!ttc && (mht || tva)) ttc = round2(mht + tva);
    const dfac = sane(calc.parseDate(cell(row, 'date_facture')));
    const dpai = sane(calc.parseDate(cell(row, 'date_paiement')));
    const numero = cell(row, 'numero');
    const rejets = [], warns = [];
    if (!notEmpty(nom) && !ice && !notEmpty(iff)) rejets.push({ champ: 'four_nom', motif: 'fournisseur manquant' });
    if (!dfac) rejets.push({ champ: 'date_facture', motif: 'date de facture absente ou invalide' });
    if (!(ttc > 0)) rejets.push({ champ: 'ttc', motif: ttc === 0 ? 'montant TTC nul' : 'montant TTC négatif/invalide' });
    if (Math.abs(ttc) >= 5e8) rejets.push({ champ: 'ttc', motif: 'montant aberrant (probable n° de compte)' });
    if (dfac && dpai && dpai < dfac) rejets.push({ champ: 'date_paiement', motif: 'date de paiement antérieure à la date de facture' });
    if (mht && tva && ttc && Math.abs(ttc - (mht + tva)) > 0.5) warns.push('TTC ≠ HT + TVA');
    if (requireNumero && !notEmpty(numero)) warns.push('numéro de facture absent (référence technique générée)');

    if (rejets.length) { stats.rejetees++; lignes.push({ ligne: r + 1, statut: 'rejetee', motif: rejets.map(x => x.motif).join(' ; '), champ: rejets[0].champ, brut, valeur: brut[col(rejets[0].champ)] }); continue; }

    const fp = fingerprint(entrepriseId, nom, numero, iso(dfac), ttc);
    const dbDup = db.prepare(`SELECT id FROM facture WHERE entreprise_id=? AND numero IS ? AND ttc=? AND date_facture IS ?`).get(entrepriseId, numero != null ? String(numero) : null, ttc, iso(dfac));
    if (seen.has(fp) || dbDup) { stats.doublons++; lignes.push({ ligne: r + 1, statut: 'doublon', motif: 'facture déjà présente (même fournisseur, n°, date, montant)', brut }); continue; }
    seen.add(fp);

    const qFac = dfac ? calc.trimestreOf(dfac) : null, yFac = dfac ? dfac.getFullYear() : null;
    if (annee != null && trimestre != null) { if (yFac === +annee && qFac === +trimestre) stats.memePeriode++; else stats.autrePeriode++; }
    if (warns.length) stats.avertissements++;
    stats.valides++; stats.totalTtc = round2(stats.totalTtc + ttc);
    lignes.push({ ligne: r + 1, statut: 'valide', avertissements: warns, brut,
      data: { nom: notEmpty(nom) ? String(nom) : null, ice, iff: notEmpty(iff) ? String(iff) : null,
        numero: notEmpty(numero) ? String(numero) : null, mht: mht || null, tva: tva || null, ttc,
        taux_tva: num(cell(row, 'taux_tva')) || null, mode_reglement: notEmpty(cell(row, 'mode_reglement')) ? String(cell(row, 'mode_reglement')) : null,
        designation: notEmpty(cell(row, 'designation')) ? String(cell(row, 'designation')) : null,
        delai_conv: num(cell(row, 'delai_conv')) || null,
        dfac: iso(dfac), dpai: iso(dpai), yFac, qFac } });
  }
  return { lignes, stats };
}

function gridOfSheet(buffer, sheetName) {
  const wb = XLSX.read(buffer, { cellDates: true });
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  return { grid: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, raw: true }), name };
}

// Prévisualisation (aucune écriture) : renvoie stats + échantillons de chaque catégorie.
function previewImport(buffer, opts) {
  const { grid, name } = gridOfSheet(buffer, opts.sheetName);
  if (!grid.length) throw new Error('Feuille vide.');
  const headerRow = opts.headerRow != null ? +opts.headerRow : detectHeader(grid).row;
  const { lignes, stats } = classifyGrid(grid, { ...opts, headerRow });
  const ech = st => lignes.filter(l => l.statut === st).slice(0, 12);
  return { feuille: name, ligneEntete: headerRow, stats,
    apercu: { valides: ech('valide'), ignorees: ech('ignoree'), rejetees: ech('rejetee'), doublons: ech('doublon') } };
}

/** Confirmation : écrit les factures valides EN TRANSACTION, stocke le détail des lignes, crée le lot. */
function confirmImport(buffer, opts) {
  const { cabinetId, entrepriseId, annee, trimestre, sourceName, userId, documentId, empreinte } = opts;
  const { grid, name } = gridOfSheet(buffer, opts.sheetName);
  if (!grid.length) throw new Error('Feuille vide.');
  const headerRow = opts.headerRow != null ? +opts.headerRow : detectHeader(grid).row;
  const { lignes, stats } = classifyGrid(grid, { ...opts, headerRow });
  const importId = uid('imp');
  const today = new Date();
  const per = { annee: +annee, trimestre: +trimestre };
  const insertFacture = db.prepare(`INSERT INTO facture
    (id, cabinet_id, entreprise_id, fournisseur_id, numero, designation, mht, tva, ttc, taux_tva, mode_reglement,
     date_facture, date_paiement, annee, periode, trimestre, source_import, import_id, import_lot_id,
     annee_origine, trimestre_origine, delai_applicable, delai_ecoule, date_limite, retard_jours, n_mois, a_declarer,
     taux_bam, taux_total, base_amende, montant_amende, couleur_risque)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insLigne = db.prepare(`INSERT INTO import_ligne (id, import_lot_id, cabinet_id, entreprise_id, numero_ligne, feuille, donnees_brutes_json, donnees_normalisees_json, statut, motif, champ, facture_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insAno = db.prepare(`INSERT INTO anomalie (id, cabinet_id, entreprise_id, type, gravite, details, entite, entite_id, annee, trimestre, import_lot_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const result = { importId, imported: 0, ignored: stats.ignorees, rejected: stats.rejetees, duplicates: stats.doublons, anomalies: 0, totalTtc: 0, amende: 0, aDeclarer: 0, convAbsente: 0, autrePeriode: stats.autrePeriode, stats };

  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO import_lot (id,cabinet_id,entreprise_id,document_id,annee,trimestre,source_nom,feuille,ligne_entete,mapping_json,statut,nb_lignes_total,nb_lignes_valides,nb_lignes_ignorees,nb_lignes_rejetees,nb_doublons,total_ttc,empreinte_fichier,utilisateur_id,confirmed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
      .run(importId, cabinetId, entrepriseId, documentId || null, per.annee, per.trimestre, sourceName || name, name, headerRow, JSON.stringify(opts.mapping || {}), 'confirme',
        stats.total, stats.valides, stats.ignorees, stats.rejetees, stats.doublons, stats.totalTtc, empreinte || null, userId || null);

    for (const l of lignes) {
      if (l.statut !== 'valide') { insLigne.run(uid('il'), importId, cabinetId, entrepriseId, l.ligne, name, JSON.stringify(l.brut || []), null, l.statut, l.motif || null, l.champ || null, null); continue; }
      const d = l.data;
      const four = upsertFournisseur(cabinetId, entrepriseId, { nom: d.nom, ice: d.ice, iff: d.iff });
      let delai;
      if (d.delai_conv) { delai = d.delai_conv; db.prepare('UPDATE fournisseur SET delai_applicable=? WHERE id=?').run(d.delai_conv, four.id); }
      else delai = lookupDelai(entrepriseId, four.id);
      const c = calc.computeFacture({ dateFacture: d.dfac, datePaiement: d.dpai, ttc: d.ttc, delaiApplicable: delai, periode: per, today, tauxProvider: (y, m) => tauxAt(y, m, cabinetId) });
      const facId = uid('fac');
      insertFacture.run(facId, cabinetId, entrepriseId, four.id, d.numero, d.designation,
        d.mht, d.tva, d.ttc, d.taux_tva, d.mode_reglement, d.dfac, d.dpai,
        per.annee, per.trimestre, per.trimestre, sourceName || name, importId, importId,
        d.yFac || null, d.qFac || null,
        delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
        c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque);
      insLigne.run(uid('il'), importId, cabinetId, entrepriseId, l.ligne, name, JSON.stringify(l.brut || []), JSON.stringify(d), 'valide', (l.avertissements || []).join(' ; ') || null, null, facId);
      if (c.delaiEcoule != null && c.delaiEcoule > 60 && !hasValidConvention(entrepriseId, four.id)) {
        result.convAbsente++;
        insAno.run(uid('ano'), cabinetId, entrepriseId, 'convention_absente', 'moyenne', `Facture ${d.numero || '?'} : délai ${c.delaiEcoule} j (> 60 j) sans convention pour ${d.nom || four.id}.`, 'facture', four.id, per.annee, per.trimestre, importId);
        result.anomalies++;
      }
      result.imported++; result.totalTtc = round2(result.totalTtc + d.ttc);
      if (c.aDeclarer) { result.aDeclarer++; result.amende = round2(result.amende + (c.montantAmende || 0)); }
    }
    db.prepare('UPDATE import_lot SET nb_lignes_valides=? WHERE id=?').run(result.imported, importId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw new Error('Import annulé (aucune donnée enregistrée) : ' + e.message); }
  return result;
}

module.exports = { importWorkbook, detectHeader, normHead, analyzeWorkbook, previewImport, confirmImport, FIELDS };
