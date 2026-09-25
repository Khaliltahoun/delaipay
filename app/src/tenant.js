'use strict';
const { tenantPalette } = require('./brand-color');
/**
 * Espace de travail (tenant) — identité et résolution par nom d'hôte.
 *
 * Un tenant DelaiPay = un CABINET (table `cabinet`, cloisonnement existant par `cabinet_id`).
 * Ce module n'ajoute AUCUNE règle métier : il fournit
 *   1. la résolution « nom d'hôte → slug » (premium.delaipay.local → « premium ») ;
 *   2. l'identité d'affichage d'un cabinet (nom affiché, couleurs, locale…) ;
 *   3. la validation des paramètres d'espace modifiables par un administrateur.
 *
 * Domaines de base reconnus : variable TENANT_BASE_DOMAINS (liste séparée par des virgules),
 * par défaut « localhost,delaipay.local » — donc AUCUN effet sur un hôte de production
 * (ex. delaipay.hlzconsulting.ma) tant que la variable n'est pas explicitement définie.
 */
const { db } = require('./db');

const DEFAULT_BASE_DOMAINS = ['localhost', 'delaipay.local'];
// Sous-domaines techniques qui ne désignent jamais un espace client.
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'static', 'assets', 'mail', 'status']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const LOCALES = ['fr-MA', 'fr-FR', 'ar-MA', 'en-US'];
const DEVISES = ['MAD'];
const FUSEAUX = ['Africa/Casablanca', 'Europe/Paris', 'UTC'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function baseDomains() {
  const raw = process.env.TENANT_BASE_DOMAINS;
  const list = raw != null ? raw.split(',') : DEFAULT_BASE_DOMAINS;
  return list.map(s => s.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
}

/** « premium.delaipay.local:4100 » → « premium » ; null si l'hôte ne désigne pas un espace. */
function slugFromHost(host, domains = baseDomains()) {
  if (!host) return null;
  const h = String(host).toLowerCase().trim().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!h || /^[\d.]+$/.test(h) || h.includes('[')) return null; // IPv4 / IPv6
  for (const d of domains) {
    if (!h.endsWith('.' + d)) continue;
    const sub = h.slice(0, -(d.length + 1));
    if (!sub || sub.includes('.')) return null;           // un seul niveau : <slug>.<domaine>
    if (RESERVED.has(sub) || !SLUG_RE.test(sub)) return null;
    return sub;
  }
  return null;
}

function hostOf(req) {
  // req.hostname respecte « trust proxy » (X-Forwarded-Host derrière nginx) ; repli sur l'en-tête Host.
  return (req && (req.hostname || (req.headers && req.headers.host))) || '';
}

function cabinetBySlug(slug) {
  if (!slug) return null;
  return db.prepare('SELECT * FROM cabinet WHERE lower(slug)=?').get(String(slug).toLowerCase()) || null;
}

/**
 * Contexte d'espace de la requête :
 *   { slug:null }                 → hôte neutre (localhost, IP, domaine de production actuel) : aucun filtrage
 *   { slug, cabinet }             → espace connu
 *   { slug, cabinet:null }        → sous-domaine d'espace inconnu
 */
function resolve(req) {
  const slug = slugFromHost(hostOf(req));
  if (!slug) return { slug: null, cabinet: null };
  return { slug, cabinet: cabinetBySlug(slug) };
}

function initialsOf(name) {
  const words = String(name || '').replace(/\b(STE|SARL|SA|SAS|SNC|AU|CABINET)\b/gi, ' ').trim().split(/\s+/).filter(Boolean);
  return (words.slice(0, 2).map(w => w[0]).join('') || 'DP').toUpperCase();
}

/** Identité publique d'un cabinet — AUCUNE donnée interne (pas d'id, pas de contact). */
function publicBranding(cab) {
  if (!cab) return { known: false, product: 'DelaiPay' };
  const displayName = cab.nom_affiche || cab.nom;
  return {
    known: true, product: 'DelaiPay', slug: cab.slug || null, displayName,
    initials: initialsOf(displayName),
    primaryColor: COLOR_RE.test(cab.couleur_primaire || '') ? cab.couleur_primaire : null,
    accentColor: COLOR_RE.test(cab.couleur_accent || '') ? cab.couleur_accent : null,
    // Variantes accessibles de la couleur d'espace (texte du monogramme ≥ 4,5:1, repère actif ≥ 3:1).
    palette: tenantPalette(COLOR_RE.test(cab.couleur_primaire || '') ? cab.couleur_primaire : null),
    locale: cab.locale || 'fr-MA',
    active: cab.actif !== 0,
    // Logo servi par /api/tenant/logo (public, hôte) ; le suffixe ?v= change à chaque remplacement.
    logoUrl: cab.logo ? `/api/tenant/logo?v=${encodeURIComponent(String(cab.logo).slice(5, 13))}` : null,
  };
}

/** Identité complète (utilisateur authentifié du cabinet). */
function workspaceOf(cab) {
  if (!cab) return null;
  return {
    ...publicBranding(cab),
    nom: cab.nom, nomAffiche: cab.nom_affiche || null, plan: cab.plan || null,
    devise: cab.devise || 'MAD', fuseauHoraire: cab.fuseau_horaire || 'Africa/Casablanca',
    contactEmail: cab.contact_email || null, contactTelephone: cab.contact_telephone || null,
    raisonLegale: cab.raison_legale || null, adresse: cab.adresse || null,
    hasLogo: !!cab.logo,
    logoUrl: cab.logo ? `/api/workspace/logo?v=${encodeURIComponent(String(cab.logo).slice(5, 13))}` : null,
    createdAt: cab.created_at || null, updatedAt: cab.updated_at || null,
  };
}

/**
 * Valide un PATCH d'identité d'espace. Seuls les champs d'affichage sont modifiables :
 * le slug (= sous-domaine) et le plan relèvent du provisionnement, jamais de l'interface.
 * @returns {{ok:true, values:object}|{ok:false, error:string}}
 */
function validateWorkspacePatch(b, opts = {}) {
  b = b || {};
  const v = {};
  const LBL = { nomAffiche: 'Nom affiché', contactEmail: 'E-mail de contact', contactTelephone: 'Téléphone', raisonLegale: 'Raison sociale', adresse: 'Adresse', locale: 'Langue', devise: 'Devise', fuseauHoraire: 'Fuseau horaire' };
  const txt = (k, col, max) => {
    if (b[k] === undefined) return null;
    const s = b[k] == null ? '' : String(b[k]).trim();
    if (s.length > max) return `« ${LBL[k] || k} » : ${max} caractères maximum.`;
    v[col] = s || null; return null;
  };
  const errs = [
    txt('nomAffiche', 'nom_affiche', 80),
    txt('contactEmail', 'contact_email', 120),
    txt('contactTelephone', 'contact_telephone', 40),
    txt('raisonLegale', 'raison_legale', 160),
    txt('adresse', 'adresse', 240),
  ].filter(Boolean);
  if (errs.length) return { ok: false, error: errs[0] };
  if (v.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contact_email)) return { ok: false, error: 'Adresse e-mail de contact invalide.' };
  for (const [k, col] of [['primaryColor', 'couleur_primaire'], ['accentColor', 'couleur_accent']]) {
    if (b[k] === undefined) continue;
    if (b[k] == null || b[k] === '') { v[col] = null; continue; }
    if (!COLOR_RE.test(String(b[k]))) return { ok: false, error: 'Couleur invalide : format #RRGGBB attendu.' };
    v[col] = String(b[k]).toUpperCase();
  }
  for (const [k, col, allowed] of [['locale', 'locale', LOCALES], ['devise', 'devise', DEVISES], ['fuseauHoraire', 'fuseau_horaire', FUSEAUX]]) {
    if (b[k] === undefined || (opts.allowEmpty && (b[k] == null || b[k] === ''))) continue;
    if (!allowed.includes(b[k])) return { ok: false, error: `Valeur non prise en charge pour « ${LBL[k] || k} ».` };
    v[col] = b[k];
  }
  if (!Object.keys(v).length && !opts.allowEmpty) return { ok: false, error: 'Aucun champ modifiable fourni.' };
  return { ok: true, values: v };
}

module.exports = {
  slugFromHost, resolve, cabinetBySlug, publicBranding, workspaceOf, validateWorkspacePatch,
  baseDomains, initialsOf, LOCALES, DEVISES, FUSEAUX, SLUG_RE,
};
