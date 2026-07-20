'use strict';
/**
 * Règle spéciale « OPÉRATEUR DE RÉSEAU » (télécom, eau, électricité, régies / SRM).
 * SOURCE UNIQUE de la classification et du délai autorisé de ces fournisseurs.
 *
 *  - délai autorisé = 30 jours calendaires (prioritaire sur 60 j / défaut / import) ;
 *  - factures EXCLUES des tableaux DÉCLARATIFS (mais conservées en suivi interne) ;
 *  - une classification fondée UNIQUEMENT sur le nom est « proposée » et doit être CONFIRMÉE ;
 *    l'ICE / l'IF / le RC priment sur le nom.
 */
const DELAI_RESEAU = 30;
const MOTIF_RESEAU = 'Opérateur de réseau — délai spécifique de 30 jours';

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Groupes d'alias → catégorie. Alias comparés comme SEGMENTS de mots entiers (anti faux positifs).
const GROUPES = [
  { categorie: 'telecom', libelle: 'Maroc Telecom', alias: ['maroc telecom', 'iam', 'itissalat al maghrib', 'itissalat almaghrib'] },
  { categorie: 'telecom', libelle: 'Orange Maroc', alias: ['orange maroc', 'orange', 'medi telecom', 'meditel'] },
  { categorie: 'telecom', libelle: 'inwi', alias: ['inwi', 'wana corporate', 'wana'] },
  { categorie: 'societe_regionale_multiservices', libelle: 'Société régionale multiservices', alias: ['srm', 'societe regionale multiservices', 'societe regionale multi services'] },
  { categorie: 'regie_distribution', libelle: 'Régie / distributeur eau & électricité', alias: ['regie autonome', 'ramsa', 'radeema', 'radeef', 'radeej', 'radeel', 'radeema', 'radeeo', 'lydec', 'amendis', 'redal', 'onee', 'office national electricite', 'office national de l electricite et de l eau potable'] },
];
// Alias GÉNÉRIQUES/courts : match ⇒ « à vérifier » (jamais classement définitif sur le seul nom).
const GENERIQUES = new Set(['orange', 'wana', 'srm', 'iam']);

/**
 * Propose une classification à partir du NOM (les identifiants priment, gérés par l'appelant).
 * @returns {{isOperateur:boolean, categorie?:string, libelle?:string, alias?:string, ambigu?:boolean, confidence?:number, matchType?:string}}
 */
function classifyReseau({ nom } = {}) {
  const n = norm(nom);
  if (!n) return { isOperateur: false };
  const words = ' ' + n + ' ';
  for (const g of GROUPES) {
    for (const a of g.alias) {
      if (words.includes(' ' + a + ' ')) {
        const ambigu = GENERIQUES.has(a);
        return { isOperateur: true, categorie: g.categorie, libelle: g.libelle, alias: a, ambigu, confidence: ambigu ? 0.5 : 0.9, matchType: 'nom' };
      }
    }
  }
  return { isOperateur: false };
}

/**
 * Délai autorisé applicable à une facture — FONCTION CENTRALE (backend = vérité).
 * Ordre : 1) opérateur réseau CONFIRMÉ (30 j) ; 2) convention active ; 3) délai fournisseur / standard 60 j.
 * @returns {{delaiAutorise:number, sourceRegle:string, horsTableauDeclaratif:boolean, motif:(string|null), classificationConfirmee:boolean}}
 */
function resolveDelaiAutorise({ fournisseur, convention } = {}) {
  const calc = require('./calc');
  if (fournisseur && fournisseur.operateur_reseau && fournisseur.statut_classification === 'confirme') {
    return { delaiAutorise: DELAI_RESEAU, sourceRegle: 'operateur_reseau', horsTableauDeclaratif: !!fournisseur.hors_tableau_declaratif, motif: fournisseur.motif_regle_speciale || MOTIF_RESEAU, classificationConfirmee: true };
  }
  if (convention && convention.delai_convenu != null) {
    return { delaiAutorise: calc.saneDelai(convention.delai_convenu), sourceRegle: 'convention', horsTableauDeclaratif: false, motif: null, classificationConfirmee: false };
  }
  const d = fournisseur && fournisseur.delai_applicable ? calc.saneDelai(fournisseur.delai_applicable) : 60;
  return { delaiAutorise: d, sourceRegle: 'standard', horsTableauDeclaratif: false, motif: null, classificationConfirmee: false };
}

// Une facture est-elle exclue des tableaux déclaratifs ? (opérateur réseau CONFIRMÉ + drapeau)
function estHorsTableauDeclaratif(fournisseur) {
  return !!(fournisseur && fournisseur.operateur_reseau && fournisseur.statut_classification === 'confirme' && fournisseur.hors_tableau_declaratif);
}

module.exports = { DELAI_RESEAU, MOTIF_RESEAU, norm, classifyReseau, resolveDelaiAutorise, estHorsTableauDeclaratif, GROUPES, GENERIQUES };
