'use strict';
const crypto = require('crypto');

function uid(prefix = '') {
  return (prefix ? prefix + '_' : '') + crypto.randomBytes(9).toString('base64url');
}

/** Montant en format marocain : 350 964,45 */
function fmtMoney(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  const neg = n < 0; n = Math.abs(Number(n));
  const fixed = n.toFixed(dec);
  let [int, frac] = fixed.split('.');
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + int + (dec ? ',' + frac : '');
}

function fmtDateFr(iso) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function trimestreLabel(t) { return `Trimestre ${t}`; }

/** ICE normalisé : chaîne de 15 chiffres, zéros de tête conservés. */
function normalizeIce(v) {
  if (v == null) return null;
  const digits = String(v).replace(/\D/g, '');
  return digits ? digits.padStart(15, '0') : null;
}

/**
 * Nom de fournisseur normalisé pour la COMPARAISON UNIQUEMENT (jamais pour l'affichage/stockage).
 * Ignore : casse, accents, espaces (début/fin/multiples), tabulations, tirets, underscores,
 * ponctuation simple. Les formes juridiques usuelles (SARL, SA, STE…) sont également neutralisées
 * pour un rapprochement prudent. Le nom affiché reste TOUJOURS celui du fichier source.
 * Ex. : « HLZ », « hlz », « HlZ » → « hlz » ; « HLZ Consulting », « HLZ-Consulting »,
 *       « HLZ_Consulting », « HLZ   Consulting » → « hlz consulting ».
 */
function normalizeSupplierName(s) {
  let n = String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  n = n.replace(/[^a-z0-9]+/g, ' ').trim();               // séparateurs/ponctuation → espace unique
  const stripped = n.replace(/\b(sarlau|sarl|sasu|sas|snc|scs|sca|sa|gie|eurl|societe|ste|cie)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return stripped || n;                                   // ne jamais renvoyer une chaîne vide si un nom existait
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'cabinet';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { uid, fmtMoney, fmtDateFr, trimestreLabel, normalizeIce, normalizeSupplierName, slugify, escapeHtml };
