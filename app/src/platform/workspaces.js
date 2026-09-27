'use strict';
/**
 * Console — vues MÉTADONNÉES des espaces : identité, statut, abonnement, volumétrie (compteurs uniquement).
 * Aucun nom de client, aucune facture, aucune déclaration n'est jamais renvoyé par ce module.
 */
const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('../db');
const lifecycle = require('../lifecycle');
const sessions = require('../sessions');
const tenant = require('../tenant');

/* Empreinte en base : part des pages de chaque table au prorata des lignes de l'espace (dbstat), + fichiers. */
const FOOT_TABLES = ['entreprise', 'fournisseur', 'convention', 'facture', 'declaration', 'anomalie', 'document', 'audit_log',
  'periode_declaration', 'import_lot', 'import_ligne', 'modele_mapping', 'utilisateur', 'invitation', 'user_session'];
let footCache = { at: 0, sizes: null, totals: null };
function tableSizes() {
  if (footCache.sizes && Date.now() - footCache.at < 60e3) return footCache;
  const sizes = {}, totals = {};
  try { for (const r of db.prepare('SELECT name, SUM(pgsize) s FROM dbstat GROUP BY name').all()) sizes[r.name] = r.s; } catch (_) {}
  for (const t of FOOT_TABLES) { try { totals[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch (_) { totals[t] = 0; } }
  footCache = { at: Date.now(), sizes, totals };
  return footCache;
}
function footprint(cabinetId) {
  const { sizes, totals } = tableSizes();
  let bytes = 0;
  for (const t of FOOT_TABLES) {
    if (!totals[t] || !sizes[t]) continue;
    const n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE cabinet_id=?`).get(cabinetId).n;
    bytes += sizes[t] * n / totals[t];
  }
  let files = 0;
  const up = path.join(__dirname, '..', '..', 'uploads');
  for (const r of db.prepare('SELECT chemin FROM document WHERE cabinet_id=? AND chemin IS NOT NULL').all(cabinetId)) {
    try { files += fs.statSync(path.isAbsolute(r.chemin) ? r.chemin : path.join(up, r.chemin)).size; } catch (_) {}
  }
  for (const r of db.prepare('SELECT fichier FROM convention WHERE cabinet_id=? AND fichier IS NOT NULL').all(cabinetId)) {
    try { files += fs.statSync(path.isAbsolute(r.fichier) ? r.fichier : path.join(up, r.fichier)).size; } catch (_) {}
  }
  return { base: Math.round(bytes), fichiers: files, total: Math.round(bytes) + files };
}

function counts(cabinetId) {
  const n = sql => db.prepare(sql).get(cabinetId).n;
  return {
    utilisateurs: n('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=? AND actif=1'),
    utilisateursTotal: n('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=?'),
    invitations: n(`SELECT COUNT(*) n FROM invitation WHERE cabinet_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')`),
    clients: n('SELECT COUNT(*) n FROM entreprise WHERE cabinet_id=?'),
    factures: n('SELECT COUNT(*) n FROM facture WHERE cabinet_id=?'),
    sessionsActives: sessions.activeCount(cabinetId),
  };
}
function lastActivity(cabinetId) {
  const a = db.prepare(`SELECT MAX(last_seen_at) t FROM user_session WHERE cabinet_id=? AND type='utilisateur'`).get(cabinetId).t;
  const b = db.prepare('SELECT MAX(derniere_connexion) t FROM utilisateur WHERE cabinet_id=?').get(cabinetId).t;
  return [a, b].filter(Boolean).sort().pop() || null;
}

function summary(cab, { withFootprint = true } = {}) {
  const sub = lifecycle.subscriptionState(cab.id);
  const statut = lifecycle.statusOf(cab, sub);
  const c = counts(cab.id);
  return {
    id: cab.id, nom: cab.nom, nomAffiche: cab.nom_affiche || null, slug: cab.slug || null,
    statut, statutLabel: lifecycle.STATUS_FR[statut], plan: cab.plan || null, planLabel: lifecycle.PLANS[cab.plan] || cab.plan || null,
    abonnement: sub.configured ? { etat: sub.etat, date_debut: sub.date_debut || null, date_fin: sub.date_fin || null, fin_grace: sub.fin_grace || null,
      jours_restants: sub.jours_restants == null ? null : sub.jours_restants, montant: sub.montant == null ? null : sub.montant, statut_paiement: sub.statut_paiement || null } : null,
    ...c, limites: lifecycle.limitsOf(cab),
    derniereActivite: lastActivity(cab.id), createdAt: cab.created_at,
    empreinte: withFootprint ? footprint(cab.id) : null,
    supprimeLe: cab.supprime_le || null, purgeApres: cab.purge_apres || null, suspenduLe: cab.suspendu_le || null,
  };
}
function list() { return db.prepare('SELECT * FROM cabinet ORDER BY created_at').all().map(c => summary(c)); }

/** Détail : identité et réglages — jamais de données métier (seulement des compteurs). */
function detail(cabinetId) {
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(cabinetId);
  if (!cab) return null;
  const sub = lifecycle.subscriptionState(cab.id);
  const ex = lifecycle.lastExport(cab.id);
  return {
    ...summary(cab),
    identite: { nom: cab.nom, nomAffiche: cab.nom_affiche || null, raisonLegale: cab.raison_legale || null, adresse: cab.adresse || null,
      ice: cab.ice || null, ifFiscal: cab.if_fiscal || null, contactNom: cab.contact_nom || null, contactEmail: cab.contact_email || null,
      contactTelephone: cab.contact_telephone || null, couleur: cab.couleur_primaire || null, hasLogo: !!cab.logo },
    abonnementComplet: sub.configured ? sub : null,
    suspension: cab.actif === 0 && !cab.supprime_le ? { le: cab.suspendu_le, motif: cab.suspension_motif } : null,
    suppression: cab.supprime_le ? { le: cab.supprime_le, purgeApres: cab.purge_apres, motif: cab.suppression_motif } : null,
    maintenance: lifecycle.activeMaint(lifecycle.parseMaint(cab.maintenance_json)),
    dernierExport: ex ? { id: ex.id, fichier: ex.fichier, sha256: ex.sha256, taille: ex.taille, le: ex.created_at, par: ex.par } : null,
    hotes: cab.slug ? tenant.baseDomains().map(d => `${cab.slug}.${d}`) : [],
    politique: (() => { try { return require('../access-policy').policyOf(cab); } catch (_) { return null; } })(),
  };
}

module.exports = { list, detail, summary, counts, footprint };
