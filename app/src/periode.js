'use strict';
/**
 * Calendrier déclaratif — loi 69-21.
 * SOURCE UNIQUE DE VÉRITÉ pour les périodes trimestrielles (aucune date en dur ailleurs).
 *
 * Chaque trimestre est traité LE MOIS SUIVANT sa clôture :
 *   T1 (jan–mar) → traité en avril
 *   T2 (avr–jun) → traité en juillet
 *   T3 (jui–sep) → traité en octobre
 *   T4 (oct–déc) → traité en JANVIER de l'année SUIVANTE
 */

const pad = n => String(n).padStart(2, '0');

/* ------- statuts du cycle de vie d'une période déclarative ------- */
const STATUTS = {
  A_VENIR: 'a_venir',
  OUVERTE: 'ouverte',
  EN_PREPARATION: 'en_preparation',
  A_CONTROLER: 'a_controler',
  PRETE: 'prete',
  VALIDEE: 'validee',
  DECLAREE: 'declaree',
  CLOTUREE: 'cloturee',
  ROUVERTE: 'rouverte',
};
const STATUT_LABELS = {
  a_venir: 'À venir',
  ouverte: 'Ouverte',
  en_preparation: 'En préparation',
  a_controler: 'À contrôler',
  prete: 'Prête à déclarer',
  validee: 'Validée',
  declaree: 'Déclarée',
  cloturee: 'Clôturée',
  rouverte: 'Rouverte exceptionnellement',
};
// Statuts qui rendent la période en LECTURE SEULE (écritures interdites par défaut).
const STATUTS_VERROUILLES = new Set([STATUTS.DECLAREE, STATUTS.CLOTUREE]);
const STATUTS_VALIDES = new Set(Object.values(STATUTS));

/* ------- helpers trimestre ------- */
function quarterOfMonth(m1) { return Math.floor((m1 - 1) / 3) + 1; }        // m1 = 1..12 → 1..4
function trimestreOfDate(d) { return quarterOfMonth(d.getMonth() + 1); }
function periodKey(annee, trimestre) { return `${Number(annee)}-${Number(trimestre)}`; }
function isValidPeriod(annee, trimestre) {
  annee = Number(annee); trimestre = Number(trimestre);
  return Number.isInteger(annee) && annee >= 2015 && annee <= 2035 && [1, 2, 3, 4].includes(trimestre);
}

/**
 * Informations complètes d'une période (bornes + calendrier de traitement).
 * Gère explicitement le passage d'année pour T4.
 */
function periodInfo(annee, trimestre) {
  annee = Number(annee); trimestre = Number(trimestre);
  const firstMonth = (trimestre - 1) * 3 + 1;   // 1,4,7,10
  const lastMonth = trimestre * 3;              // 3,6,9,12
  const lastDay = new Date(annee, lastMonth, 0).getDate();
  let mois_traitement = lastMonth + 1, annee_traitement = annee;
  if (mois_traitement > 12) { mois_traitement -= 12; annee_traitement += 1; }   // T4 → janvier N+1
  const dernierJourTraitement = new Date(annee_traitement, mois_traitement, 0).getDate();
  return {
    annee, trimestre,
    label: `T${trimestre} ${annee}`,
    date_debut: `${annee}-${pad(firstMonth)}-01`,
    date_fin: `${annee}-${pad(lastMonth)}-${pad(lastDay)}`,
    mois_traitement, annee_traitement,
    // fenêtre prévisionnelle de traitement (le mois qui suit la clôture)
    date_ouverture_prev: `${annee_traitement}-${pad(mois_traitement)}-01`,
    date_cloture_prev: `${annee_traitement}-${pad(mois_traitement)}-${pad(dernierJourTraitement)}`,
  };
}

/** Trimestre « en cours de traitement » à une date : le plus récent dont le mois de traitement ≤ aujourd'hui. */
function workingPeriod(today = new Date()) {
  const ty = today.getFullYear(), tm = today.getMonth() + 1, now = ty * 12 + tm;
  let best = null;
  for (const y of [ty, ty - 1]) {
    for (let t = 1; t <= 4; t++) {
      const info = periodInfo(y, t);
      const key = info.annee_traitement * 12 + info.mois_traitement;
      if (key <= now && (!best || key > best.key)) best = { annee: y, trimestre: t, key };
    }
  }
  return best ? { annee: best.annee, trimestre: best.trimestre } : { annee: ty, trimestre: quarterOfMonth(tm) };
}

/** Statut par défaut dérivé du calendrier (tant qu'aucun statut n'est fixé manuellement). */
function defaultStatut(annee, trimestre, today = new Date()) {
  const info = periodInfo(annee, trimestre);
  const now = today.getFullYear() * 12 + (today.getMonth() + 1);
  const finTrimestre = info.annee * 12 + info.trimestre * 3;
  const moisTraitement = info.annee_traitement * 12 + info.mois_traitement;
  if (now < moisTraitement) return finTrimestre <= now ? STATUTS.A_VENIR : STATUTS.A_VENIR;
  if (now === moisTraitement) return STATUTS.OUVERTE;
  return STATUTS.EN_PREPARATION;
}

/** Nombre de jours entre aujourd'hui et l'échéance de dépôt (fin du mois de traitement). */
function joursAvantEcheance(annee, trimestre, today = new Date()) {
  const info = periodInfo(annee, trimestre);
  const echeance = new Date(info.date_cloture_prev + 'T00:00:00');
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((echeance - t0) / 86400000);
}

function isLocked(statut) { return STATUTS_VERROUILLES.has(statut); }

/** Trimestres précédent / suivant (avec passage d'année). */
function prevPeriod(annee, trimestre) {
  annee = Number(annee); trimestre = Number(trimestre);
  return trimestre === 1 ? { annee: annee - 1, trimestre: 4 } : { annee, trimestre: trimestre - 1 };
}
function nextPeriod(annee, trimestre) {
  annee = Number(annee); trimestre = Number(trimestre);
  return trimestre === 4 ? { annee: annee + 1, trimestre: 1 } : { annee, trimestre: trimestre + 1 };
}

module.exports = {
  STATUTS, STATUT_LABELS, STATUTS_VERROUILLES, STATUTS_VALIDES,
  quarterOfMonth, trimestreOfDate, periodKey, isValidPeriod,
  periodInfo, workingPeriod, defaultStatut, joursAvantEcheance, isLocked,
  prevPeriod, nextPeriod,
};
