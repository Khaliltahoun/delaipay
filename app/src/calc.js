'use strict';
/**
 * Moteur de calcul des délais de paiement — Loi 69-21.
 *
 * Modèle RÉEL validé sur les déclarations DGI de CADOZAT (T1 2026) :
 *  - date limite   = date_facture + délai_applicable (60 j sans convention, 120 j avec, ou sectoriel)
 *  - DATE D'ARRÊTÉ (règle métier) : pour un trimestre de déclaration donné, le délai est
 *    constaté à la date d'arrêté = date de paiement si payée au plus tard le dernier jour du
 *    trimestre, SINON le dernier jour du trimestre (facture impayée OU payée après la clôture).
 *    → délai constaté = date d'arrêté − date de facture (jours calendaires).
 *    Voir getDateArreteFacture(). La date du jour n'arrête JAMAIS un trimestre.
 *  - retard        = date d'arrêté − date limite (jamais négatif ; = délai constaté − délai autorisé)
 *  - amende trimestrielle = TTC × Σ taux(mois de retard tombant DANS le trimestre déclaré)
 *      • le TOUT PREMIER mois de retard (sur la vie de la facture) = taux directeur Bank Al-Maghrib
 *      • chaque mois (ou fraction) suivant = 0,85 %
 *  - DÉCOUPAGE PAR MOIS CALENDAIRE (confirmé par Mme Zahra) : tout mois calendaire touché par
 *    le retard compte pour un mois entier.
 *
 * Reproduit au centime : TRACTAFRIC 245 595,80 → 5 525,91 (2,25 %) ; PNEUMATIQUE 6 600 → 112,20
 * (1,70 %) ; BG EXPRESS 3 050 → 25,93 (0,85 %). Total T1 CADOZAT : 7 026,00 DH.
 */

const periode = require('./periode');   // SOURCE UNIQUE des bornes de trimestre (pas de date en dur)
const TAUX_MOIS_SUPP = 0.0085; // 0,85 % par mois/fraction supplémentaire (loi 69-21)

// Délai maximal LÉGAL d'un délai applicable/convenu (loi 69-21 : 60 j par défaut,
// jusqu'à 120 j par convention). AUCUN délai appliqué ne peut dépasser ce plafond.
const DELAI_LEGAL_DEFAUT = 60;
const DELAI_MAX = 120;
// Ramène n'importe quelle valeur à un délai RÉEL en jours : entier dans [1, 120].
// Une valeur nulle/négative/illisible → 60 j (défaut légal) ; > 120 → 120 (plafond).
// Protège tout le moteur contre des données corrompues (ex. « 60 120 » concaténé → 60120).
function saneDelai(v, fallback = DELAI_LEGAL_DEFAUT) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, DELAI_MAX);
}

/* ------------------------------------------------------------------ dates */
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return atMidnight(v);
  if (typeof v === 'number') {
    // Numéro de série Excel (base 1899-12-30)
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : atMidnight(d);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            // yyyy-mm-dd
  if (m) return atMidnight(new Date(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); // dd/mm/yyyy
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return atMidnight(new Date(y, +m[2] - 1, +m[1]));
  }
  const d = new Date(s);
  return isNaN(d) ? null : atMidnight(d);
}
function atMidnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function daysBetween(a, b) { return Math.round((atMidnight(b) - atMidnight(a)) / 86400000); }
function iso(d) { return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null; }
function pad(n) { return String(n).padStart(2, '0'); }

/* ------------------------------------------------------ date d'arrêté (règle métier) */
// Dernier jour calendaire d'un trimestre (T1→31/03, T2→30/06, T3→30/09, T4→31/12 de l'année N).
// T4 est TRAITÉ en janvier N+1 mais son arrêté reste le 31/12/N (source : periode.periodInfo).
function getFinTrimestre(annee, trimestre) {
  return parseDate(periode.periodInfo(annee, trimestre).date_fin);
}
/**
 * Date d'ARRÊTÉ d'une facture pour un trimestre de déclaration (source de vérité UNIQUE).
 *  - payée au plus tard le dernier jour du trimestre → arrêté = date de paiement ;
 *  - impayée à la clôture OU payée APRÈS la clôture   → arrêté = dernier jour du trimestre ;
 *  - facture postérieure au trimestre / paiement antérieur à la facture → incohérence (jamais de délai négatif).
 * @returns {{dateArrete:Date, dateArreteIso:string, finTrimIso:string, etat:string, delaiConstate:(number|null)}}
 *   etat ∈ 'paye' | 'impaye_cloture' | 'paye_apres_cloture' | 'facture_hors_periode' | 'paiement_anterieur'
 */
function getDateArreteFacture({ dateFacture, datePaiement, annee, trimestre }) {
  const dfac = parseDate(dateFacture);
  const dpai = parseDate(datePaiement);
  const finTrim = getFinTrimestre(annee, trimestre);
  let dateArrete, etat;
  if (dpai && dpai <= finTrim) { dateArrete = dpai; etat = 'paye'; }
  else if (dpai && dpai > finTrim) { dateArrete = finTrim; etat = 'paye_apres_cloture'; }
  else { dateArrete = finTrim; etat = 'impaye_cloture'; }
  let delaiConstate = dfac ? daysBetween(dfac, dateArrete) : null;
  // Sécurité : aucune valeur négative ne doit être produite silencieusement.
  if (dfac && dfac > dateArrete) {
    etat = (dfac > finTrim) ? 'facture_hors_periode' : 'paiement_anterieur';
    delaiConstate = null;
  }
  return { dateArrete, dateArreteIso: iso(dateArrete), finTrimIso: iso(finTrim), etat, delaiConstate };
}

function trimestreOf(d) { return Math.floor(d.getMonth() / 3) + 1; }         // 1..4
function quarterMonths(annee, trimestre) {                                   // [{y,m}] m:1..12
  const start = (trimestre - 1) * 3;
  return [0, 1, 2].map(i => ({ y: annee, m: start + i + 1 }));
}
function ymKey(y, m) { return y * 100 + m; }

/**
 * Liste des mois calendaires (clé aaaamm) touchés par le retard [dateLimite+1 .. fin].
 * Le premier mois de retard = mois calendaire du lendemain de la date limite.
 */
function retardMonths(dateLimite, fin) {
  const start = addDays(dateLimite, 1);
  if (fin < start) return [];
  const out = [];
  let y = start.getFullYear(), m = start.getMonth() + 1;
  const endKey = ymKey(fin.getFullYear(), fin.getMonth() + 1);
  while (ymKey(y, m) <= endKey) {
    out.push({ y, m, key: ymKey(y, m) });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* ------------------------------------------------------ calcul d'une facture */
/**
 * @param opts.dateFacture (Date|string)  date d'émission
 * @param opts.datePaiement (Date|string|null) date de règlement ; null = impayée
 * @param opts.ttc (number) base TTC concernée
 * @param opts.delaiApplicable (number) 60 / 120 / délai sectoriel
 * @param opts.tauxProvider (y,m)=>taux directeur BAM en vigueur ce mois (déf. 0.0225)
 * @param opts.periode {annee, trimestre} période déclarée ; déf. = trimestre du paiement
 * @param opts.today (Date) référence pour les factures impayées
 */
function computeFacture(opts) {
  const dfac = parseDate(opts.dateFacture);
  const dpai = parseDate(opts.datePaiement);
  const ttc = Number(opts.ttc) || 0;
  // Garde-fou LÉGAL : le délai appliqué est TOUJOURS ramené à [1, 120] j (jamais de valeur
  // aberrante qui masquerait un retard réel). C'est le point de passage unique du calcul.
  const delai = saneDelai(opts.delaiApplicable);
  const today = opts.today ? parseDate(opts.today) : atMidnight(new Date());
  const tauxProvider = opts.tauxProvider || (() => 0.0225);

  const res = {
    dateFacture: iso(dfac), datePaiement: iso(dpai), ttc,
    delaiApplicable: delai, delaiEcoule: null, dateLimite: null,
    retardJours: 0, nMois: 0, aDeclarer: false, paye: !!dpai,
    arreteAu: null, etatPaiement: null, incoherent: false,
    tauxBam: null, tauxTotal: 0, baseAmende: 0, montantAmende: 0,
    couleurRisque: 'ok', periode: null,
  };
  if (!dfac) return res;

  const dateLimite = addDays(dfac, delai);
  res.dateLimite = iso(dateLimite);

  // Fin de la période de retard = DATE D'ARRÊTÉ.
  //  - periode fournie → règle métier : paiement si ≤ dernier jour du trimestre, sinon dernier jour du trimestre ;
  //  - pas de periode (appel direct) → repli historique : paiement ou aujourd'hui.
  let fin, q;
  if (opts.periode && opts.periode.annee != null && opts.periode.trimestre != null) {
    q = { annee: +opts.periode.annee, trimestre: +opts.periode.trimestre };
    const arr = getDateArreteFacture({ dateFacture: dfac, datePaiement: dpai, annee: q.annee, trimestre: q.trimestre });
    fin = arr.dateArrete;
    res.arreteAu = arr.dateArreteIso;
    res.etatPaiement = arr.etat;
    res.periode = q;
    // Incohérences (facture postérieure au trimestre, paiement antérieur à la facture) :
    // aucun délai/retard, jamais de valeur négative — la ligne est signalée par ailleurs.
    if (arr.etat === 'facture_hors_periode' || arr.etat === 'paiement_anterieur') {
      res.incoherent = true; res.couleurRisque = 'ok'; return res;
    }
  } else {
    fin = dpai || today;
    q = { annee: fin.getFullYear(), trimestre: trimestreOf(fin) };
    res.arreteAu = iso(fin);
    res.etatPaiement = dpai ? 'paye' : 'impaye_cloture';
    res.periode = q;
  }

  res.delaiEcoule = daysBetween(dfac, fin);              // délai CONSTATÉ = arrêté − date de facture
  res.retardJours = Math.max(0, daysBetween(dateLimite, fin)); // jours de retard = max(0, constaté − autorisé) — JAMAIS négatif
  res.aDeclarer = res.retardJours > 0;

  if (res.retardJours <= 0) { res.couleurRisque = riskColor(res); return res; }

  // Mois de retard + premier mois de retard (sur la vie de la facture)
  const months = retardMonths(dateLimite, fin);
  res.nMois = months.length;
  const firstKey = months.length ? months[0].key : null;

  // Mois de retard tombant DANS le trimestre déclaré
  const qKeys = new Set(quarterMonths(q.annee, q.trimestre).map(o => ymKey(o.y, o.m)));
  let taux = 0, tauxBamUsed = null;
  for (const mo of months) {
    if (!qKeys.has(mo.key)) continue;
    if (mo.key === firstKey) {
      const t = tauxProvider(mo.y, mo.m);           // 1er mois = taux directeur BAM
      taux += t; tauxBamUsed = t;
    } else {
      taux += TAUX_MOIS_SUPP;                        // mois suivants = 0,85 %
    }
  }
  res.tauxBam = tauxBamUsed;
  res.tauxTotal = round2(taux * 100) / 100;          // en fraction
  res.baseAmende = ttc;
  res.montantAmende = round2(ttc * taux);
  res.couleurRisque = riskColor(res);
  return res;
}

function riskColor(r) {
  if (r.retardJours > 0) {
    if (r.montantAmende >= 1000 || r.retardJours >= 90) return 'dred';
    return 'red';
  }
  if (!r.paye && r.dateLimite) {
    const jr = daysBetween(atMidnight(new Date()), parseDate(r.dateLimite));
    if (jr >= 0 && jr <= 5) return 'orange';
    if (jr > 5 && jr <= 15) return 'app';
  }
  return 'ok';
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

module.exports = {
  computeFacture, parseDate, iso, daysBetween, addDays,
  trimestreOf, quarterMonths, retardMonths, round2, TAUX_MOIS_SUPP,
  saneDelai, DELAI_MAX, DELAI_LEGAL_DEFAUT,
  getFinTrimestre, getDateArreteFacture,
};
