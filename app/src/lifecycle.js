'use strict';
/**
 * Cycle de vie commercial d'un espace (INC 3A) — statut, abonnement (facturation manuelle), limites,
 * suspension, suppression douce, bandeaux de maintenance. AUCUNE règle comptable ici ; aucune suppression
 * automatique de données (la purge définitive reste une procédure manuelle documentée).
 *
 * Statut affiché :  supprimé (en délai de grâce) > suspendu > expiré > actif.
 * Abonnement expiré : accès complet pendant le délai de grâce (bandeau), puis espace en LECTURE SEULE.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, audit, DB_PATH } = require('./db');
const { uid } = require('./util');

for (const stmt of [
  "ALTER TABLE cabinet ADD COLUMN suspendu_le TEXT",
  "ALTER TABLE cabinet ADD COLUMN suspension_motif TEXT",
  "ALTER TABLE cabinet ADD COLUMN supprime_le TEXT",
  "ALTER TABLE cabinet ADD COLUMN purge_apres TEXT",
  "ALTER TABLE cabinet ADD COLUMN suppression_motif TEXT",
  "ALTER TABLE cabinet ADD COLUMN if_fiscal TEXT",
  "ALTER TABLE cabinet ADD COLUMN ice TEXT",
  "ALTER TABLE cabinet ADD COLUMN contact_nom TEXT",
  "ALTER TABLE cabinet ADD COLUMN max_utilisateurs INTEGER",
  "ALTER TABLE cabinet ADD COLUMN max_clients INTEGER",
  "ALTER TABLE cabinet ADD COLUMN maintenance_json TEXT",
]) { try { db.exec(stmt); } catch (_) {} }
db.exec(`
CREATE TABLE IF NOT EXISTS abonnement (
  cabinet_id TEXT PRIMARY KEY, plan TEXT, date_debut TEXT, date_fin TEXT, montant REAL,
  periodicite TEXT, statut_paiement TEXT DEFAULT 'en_attente', notes TEXT, grace_jours INTEGER DEFAULT 15,
  updated_at TEXT DEFAULT (datetime('now')), updated_by TEXT
);
CREATE TABLE IF NOT EXISTS workspace_export (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, fichier TEXT NOT NULL, sha256 TEXT NOT NULL, taille INTEGER,
  created_at TEXT DEFAULT (datetime('now')), par TEXT
);
`);

class LifecycleError extends Error { constructor(msg, status = 400, code) { super(msg); this.status = status; this.code = code; } }

const PLANS = { essentiel: 'Essentiel', pro: 'Pro', cabinet: 'Cabinet', sur_mesure: 'Sur mesure' };
const PAIEMENT = { paye: 'Payé', en_attente: 'En attente', en_retard: 'En retard' };
const PERIODICITE = { mensuel: 'Mensuel', trimestriel: 'Trimestriel', annuel: 'Annuel' };
const DEFAULT_GRACE = 15, DELETE_GRACE_DAYS = 30, EXPORT_VALID_H = 24;

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, d) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ abonnement */
function subscriptionOf(cabinetId) { return db.prepare('SELECT * FROM abonnement WHERE cabinet_id=?').get(cabinetId) || null; }
/**
 * État de l'abonnement à la date du jour.
 *   aucun | actif | bientot (≤ 30 j) | grace (échu, délai de grâce en cours) | lecture_seule (grâce écoulée)
 */
function subscriptionState(cabinetId, on = today()) {
  const a = subscriptionOf(cabinetId);
  if (!a || !a.date_fin) return { configured: !!a, etat: 'aucun', ...(a || {}) };
  const grace = a.grace_jours == null ? DEFAULT_GRACE : a.grace_jours;
  const finGrace = addDays(a.date_fin, grace);
  const restants = daysBetween(on, a.date_fin);
  let etat = 'actif';
  if (on > finGrace) etat = 'lecture_seule';
  else if (on > a.date_fin) etat = 'grace';
  else if (restants <= 30) etat = 'bientot';
  return { configured: true, ...a, grace_jours: grace, fin_grace: finGrace, jours_restants: restants, etat };
}
function validateSubscription(b) {
  const v = {};
  if (b.plan != null && b.plan !== '' && !PLANS[b.plan]) throw new LifecycleError('Formule inconnue.');
  v.plan = b.plan || null;
  for (const k of ['date_debut', 'date_fin']) {
    if (b[k] == null || b[k] === '') { v[k] = null; continue; }
    if (!DATE_RE.test(String(b[k]))) throw new LifecycleError('Date invalide : format AAAA-MM-JJ attendu.');
    v[k] = String(b[k]);
  }
  if (v.date_debut && v.date_fin && v.date_fin < v.date_debut) throw new LifecycleError('La date de fin (renouvellement) doit suivre la date de début.');
  if (b.montant == null || b.montant === '') v.montant = null;
  else { const m = Number(String(b.montant).replace(',', '.')); if (!(m >= 0) || m > 1e8) throw new LifecycleError('Montant invalide.'); v.montant = Math.round(m * 100) / 100; }
  if (b.periodicite && !PERIODICITE[b.periodicite]) throw new LifecycleError('Périodicité inconnue.');
  v.periodicite = b.periodicite || null;
  if (b.statut_paiement && !PAIEMENT[b.statut_paiement]) throw new LifecycleError('Statut de paiement inconnu.');
  v.statut_paiement = b.statut_paiement || 'en_attente';
  v.notes = b.notes == null ? null : String(b.notes).trim().slice(0, 1000) || null;
  const g = b.grace_jours == null || b.grace_jours === '' ? DEFAULT_GRACE : +b.grace_jours;
  if (!Number.isInteger(g) || g < 0 || g > 180) throw new LifecycleError('Délai de grâce : 0 à 180 jours.');
  v.grace_jours = g;
  return v;
}
function saveSubscription(cabinetId, input, by) {
  const v = validateSubscription(input || {});
  const avant = subscriptionOf(cabinetId);
  db.prepare(`INSERT INTO abonnement (cabinet_id, plan, date_debut, date_fin, montant, periodicite, statut_paiement, notes, grace_jours, updated_at, updated_by)
              VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)
              ON CONFLICT(cabinet_id) DO UPDATE SET plan=excluded.plan, date_debut=excluded.date_debut, date_fin=excluded.date_fin, montant=excluded.montant,
                periodicite=excluded.periodicite, statut_paiement=excluded.statut_paiement, notes=excluded.notes, grace_jours=excluded.grace_jours,
                updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(cabinetId, v.plan, v.date_debut, v.date_fin, v.montant, v.periodicite, v.statut_paiement, v.notes, v.grace_jours, by || null);
  if (v.plan) db.prepare(`UPDATE cabinet SET plan=?, updated_at=datetime('now') WHERE id=?`).run(v.plan, cabinetId);
  return { avant, apres: subscriptionOf(cabinetId) };
}

/* ------------------------------------------------------------------ statut */
function cabinet(id) { return db.prepare('SELECT * FROM cabinet WHERE id=?').get(id) || null; }
/** @returns 'supprime' | 'suspendu' | 'expire' | 'actif' */
function statusOf(cab, sub) {
  if (!cab) return null;
  if (cab.supprime_le) return 'supprime';
  if (cab.actif === 0) return 'suspendu';
  const s = sub || subscriptionState(cab.id);
  if (s.etat === 'grace' || s.etat === 'lecture_seule') return 'expire';
  return 'actif';
}
const STATUS_FR = { actif: 'Actif', suspendu: 'Suspendu', expire: 'Expiré', supprime: 'Supprimé (délai de grâce)' };

/** Mode d'accès des utilisateurs de l'espace : 'full' | 'read_only' (abonnement échu au-delà de la grâce). */
function accessMode(cabinetId) {
  const s = subscriptionState(cabinetId);
  return s.etat === 'lecture_seule' ? { mode: 'read_only', depuis: s.fin_grace, date_fin: s.date_fin } : { mode: 'full' };
}
/** Garde d'écriture côté espace (après authentification) : abonnement échu → lecture seule, message clair. */
function writeGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/me/password' || req.path === '/auth/logout') return next();
  const m = accessMode(req.cabinetId);
  if (m.mode === 'read_only') {
    const d = m.date_fin ? m.date_fin.split('-').reverse().join('/') : '';
    return res.status(403).json({ error: `L’abonnement de cet espace a expiré le ${d} : l’espace est en lecture seule (consultation et exports uniquement). Contactez DelaiPay pour le renouveler — aucune donnée n’a été supprimée.`, code: 'abonnement_expire' });
  }
  next();
}

/* ------------------------------------------------------------------ limites */
function limitsOf(cab) { return { maxUtilisateurs: cab && cab.max_utilisateurs != null ? cab.max_utilisateurs : null, maxClients: cab && cab.max_clients != null ? cab.max_clients : null }; }
function usage(cabinetId) {
  const n = sql => db.prepare(sql).get(cabinetId).n;
  return {
    utilisateurs: n('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=? AND actif=1'),
    invitations: n(`SELECT COUNT(*) n FROM invitation WHERE cabinet_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')`),
    clients: n('SELECT COUNT(*) n FROM entreprise WHERE cabinet_id=?'),
  };
}
/**
 * Vérifie qu'une création reste dans la limite de l'abonnement. kind : 'utilisateur' (invitation, compte, réactivation)
 * ou 'client'. `pendingIncluded` : compter les invitations en attente (création d'invitation).
 */
function assertLimit(cabinetId, kind, { pendingIncluded = false } = {}) {
  const cab = cabinet(cabinetId); const lim = limitsOf(cab); const u = usage(cabinetId);
  if (kind === 'client' && lim.maxClients != null && u.clients >= lim.maxClients)
    throw new LifecycleError(`Limite de l’abonnement atteinte : ${lim.maxClients} dossier${lim.maxClients > 1 ? 's' : ''} client${lim.maxClients > 1 ? 's' : ''} au maximum. Contactez DelaiPay pour augmenter cette limite.`, 403, 'limite_clients');
  if (kind === 'utilisateur' && lim.maxUtilisateurs != null) {
    const used = u.utilisateurs + (pendingIncluded ? u.invitations : 0);
    if (used >= lim.maxUtilisateurs)
      throw new LifecycleError(`Limite de l’abonnement atteinte : ${lim.maxUtilisateurs} utilisateur${lim.maxUtilisateurs > 1 ? 's' : ''} au maximum${pendingIncluded && u.invitations ? ` (dont ${u.invitations} invitation${u.invitations > 1 ? 's' : ''} en attente)` : ''}. Contactez DelaiPay pour augmenter cette limite.`, 403, 'limite_utilisateurs');
  }
}

/* ------------------------------------------------------------------ suspension / réactivation */
function tenantAudit(cabinetId, action, details, actorLabel, ip) {
  audit(cabinetId, null, action, 'espace_travail', { ...details, par: actorLabel }, ip);
}
function suspend(cabinetId, motif, actorLabel, ip) {
  const cab = cabinet(cabinetId);
  if (!cab || cab.supprime_le) throw new LifecycleError('Espace introuvable.', 404);
  if (cab.actif === 0) throw new LifecycleError('Cet espace est déjà suspendu.', 409);
  const m = String(motif || '').trim(); if (!m) throw new LifecycleError('Indiquez le motif de la suspension.');
  db.prepare(`UPDATE cabinet SET actif=0, suspendu_le=datetime('now'), suspension_motif=?, updated_at=datetime('now') WHERE id=?`).run(m.slice(0, 500), cabinetId);
  const ended = require('./sessions').endForCabinet(cabinetId, 'espace_suspendu');
  tenantAudit(cabinetId, 'suspension_espace', { motif: m }, actorLabel, ip);
  return { sessionsFermees: ended };
}
function reactivate(cabinetId, motif, actorLabel, ip) {
  const cab = cabinet(cabinetId);
  if (!cab || cab.supprime_le) throw new LifecycleError('Espace introuvable.', 404);
  if (cab.actif !== 0) throw new LifecycleError('Cet espace est déjà actif.', 409);
  const m = String(motif || '').trim(); if (!m) throw new LifecycleError('Indiquez le motif de la réactivation.');
  db.prepare(`UPDATE cabinet SET actif=1, suspendu_le=NULL, suspension_motif=NULL, updated_at=datetime('now') WHERE id=?`).run(cabinetId);
  tenantAudit(cabinetId, 'reactivation_espace', { motif: m }, actorLabel, ip);
}

/* ------------------------------------------------------------------ export puis suppression douce */
const EXPORT_DIR = () => path.join(path.dirname(DB_PATH), 'exports');
/** Tables exportées : toutes les lignes du cabinet (+ lignes filles). Les secrets ne sont JAMAIS exportés. */
const EXPORT_TABLES = ['entreprise', 'fournisseur', 'convention', 'facture', 'taux_bam', 'declaration', 'anomalie', 'document',
  'audit_log', 'periode_declaration', 'import_lot', 'import_ligne', 'modele_mapping', 'invitation', 'utilisateur'];
const SECRET_COLS = { utilisateur: ['password_hash'], invitation: ['token_hash'] };
function exportWorkspace(cabinetId, actorLabel) {
  const cab = cabinet(cabinetId); if (!cab) throw new LifecycleError('Espace introuvable.', 404);
  const out = { format: 'delaipay-export-espace', version: 1, genere_le: new Date().toISOString(), cabinet: { ...cab, logo: cab.logo ? '(fichier)' : null }, tables: {} };
  for (const t of EXPORT_TABLES) {
    let rows = db.prepare(`SELECT * FROM ${t} WHERE cabinet_id=?`).all(cabinetId);
    if (SECRET_COLS[t]) rows = rows.map(r => { const c = { ...r }; for (const k of SECRET_COLS[t]) delete c[k]; return c; });
    out.tables[t] = rows;
  }
  const declIds = out.tables.declaration.map(d => d.id);
  const inList = (tbl, col) => declIds.length ? db.prepare(`SELECT * FROM ${tbl} WHERE ${col} IN (${declIds.map(() => '?').join(',')})`).all(...declIds) : [];
  out.tables.ligne_declaration = inList('ligne_declaration', 'declaration_id');
  out.tables.visa = inList('visa', 'declaration_id');
  out.tables.abonnement = db.prepare('SELECT * FROM abonnement WHERE cabinet_id=?').all(cabinetId);
  const json = JSON.stringify(out);
  fs.mkdirSync(EXPORT_DIR(), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${cab.slug || cab.id}-${stamp}.json`;
  const file = path.join(EXPORT_DIR(), name);
  fs.writeFileSync(file, json, { mode: 0o600 });
  const sha = crypto.createHash('sha256').update(json).digest('hex');
  const id = uid('exp');
  db.prepare('INSERT INTO workspace_export (id, cabinet_id, fichier, sha256, taille, par) VALUES (?,?,?,?,?,?)').run(id, cabinetId, name, sha, Buffer.byteLength(json), actorLabel || null);
  const counts = {}; for (const [k, v] of Object.entries(out.tables)) counts[k] = v.length;
  return { id, fichier: name, chemin: path.relative(path.join(__dirname, '..'), file), sha256: sha, taille: Buffer.byteLength(json), lignes: counts };
}
function lastExport(cabinetId) { return db.prepare('SELECT * FROM workspace_export WHERE cabinet_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(cabinetId) || null; }
/**
 * Suppression DOUCE : exige un export de moins de 24 h, la saisie exacte de l'identifiant et un motif.
 * L'espace devient inaccessible ; les données restent intactes jusqu'à la purge MANUELLE (après le délai de grâce).
 */
function softDelete(cabinetId, { motif, confirmation, exportId }, actorLabel, ip) {
  const cab = cabinet(cabinetId);
  if (!cab || cab.supprime_le) throw new LifecycleError('Espace introuvable.', 404);
  if (String(confirmation || '').trim() !== String(cab.slug || '')) throw new LifecycleError('Saisissez exactement l’identifiant de l’espace pour confirmer.', 400, 'confirmation');
  const m = String(motif || '').trim(); if (!m) throw new LifecycleError('Indiquez le motif de la suppression.');
  const ex = exportId ? db.prepare('SELECT * FROM workspace_export WHERE id=? AND cabinet_id=?').get(exportId, cabinetId) : null;
  if (!ex || Date.parse(ex.created_at.replace(' ', 'T') + 'Z') < Date.now() - EXPORT_VALID_H * 3600e3)
    throw new LifecycleError('Exportez d’abord les données de l’espace (export de moins de 24 heures exigé avant toute suppression).', 409, 'export_requis');
  const purge = addDays(today(), DELETE_GRACE_DAYS);
  db.prepare(`UPDATE cabinet SET actif=0, supprime_le=datetime('now'), purge_apres=?, suppression_motif=?, updated_at=datetime('now') WHERE id=?`).run(purge, m.slice(0, 500), cabinetId);
  const ended = require('./sessions').endForCabinet(cabinetId, 'espace_supprime');
  db.prepare(`UPDATE invitation SET revoked_at=datetime('now') WHERE cabinet_id=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(cabinetId);
  tenantAudit(cabinetId, 'suppression_espace', { motif: m, export: ex.fichier, purge_possible_apres: purge }, actorLabel, ip);
  return { purgeApres: purge, sessionsFermees: ended, export: ex.fichier };
}
function restore(cabinetId, motif, actorLabel, ip) {
  const cab = cabinet(cabinetId);
  if (!cab || !cab.supprime_le) throw new LifecycleError('Cet espace n’est pas supprimé.', 409);
  const m = String(motif || '').trim(); if (!m) throw new LifecycleError('Indiquez le motif de la restauration.');
  // Restauré SUSPENDU : la réactivation reste une décision distincte, motivée.
  db.prepare(`UPDATE cabinet SET supprime_le=NULL, purge_apres=NULL, suppression_motif=NULL, actif=0, suspendu_le=datetime('now'), suspension_motif=?, updated_at=datetime('now') WHERE id=?`)
    .run('Restauré après suppression : ' + m.slice(0, 400), cabinetId);
  tenantAudit(cabinetId, 'restauration_espace', { motif: m }, actorLabel, ip);
}

/* ------------------------------------------------------------------ maintenance */
function parseMaint(json) { try { const m = JSON.parse(json || 'null'); return m && m.message ? m : null; } catch (_) { return null; } }
function validMaint(b) {
  const message = String((b && b.message) || '').trim();
  if (!message) throw new LifecycleError('Message de maintenance requis.');
  if (message.length > 300) throw new LifecycleError('Message : 300 caractères maximum.');
  let fin = b.fin ? String(b.fin) : null;
  if (fin && isNaN(Date.parse(fin))) throw new LifecycleError('Heure de fin invalide.');
  if (fin) fin = new Date(fin).toISOString();
  return { message, fin, depuis: new Date().toISOString() };
}
const activeMaint = m => m && (!m.fin || Date.parse(m.fin) > Date.now()) ? m : null;
/** Bandeaux de maintenance actifs pour un espace (global puis espace). */
function maintenanceFor(cab) {
  const out = [];
  const g = activeMaint(require('./platform/store').getSetting('maintenance', null));
  if (g) out.push({ portee: 'plateforme', message: g.message, fin: g.fin || null });
  const w = cab ? activeMaint(parseMaint(cab.maintenance_json)) : null;
  if (w) out.push({ portee: 'espace', message: w.message, fin: w.fin || null });
  return out;
}

module.exports = {
  LifecycleError, PLANS, PAIEMENT, PERIODICITE, STATUS_FR, DEFAULT_GRACE, DELETE_GRACE_DAYS,
  subscriptionOf, subscriptionState, saveSubscription, statusOf, accessMode, writeGuard,
  limitsOf, usage, assertLimit, suspend, reactivate, exportWorkspace, lastExport, softDelete, restore,
  validMaint, parseMaint, activeMaint, maintenanceFor, tenantAudit, today, addDays,
};
