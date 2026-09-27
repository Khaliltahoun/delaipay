'use strict';
/**
 * Accès d'assistance DelaiPay à un espace (INC 3A).
 *
 * La console ne montre jamais de données métier. Pour voir l'espace d'un client, un administrateur plateforme
 * ouvre un ACCÈS D'ASSISTANCE : motif obligatoire, durée ≤ 2 h, LECTURE SEULE, inscrit au journal de la plateforme
 * ET au journal de l'espace (visible par son administrateur, et dans Paramètres → Sécurité), fin automatique.
 *
 * Mécanisme : la console crée l'accès et un lien d'ouverture à usage unique (2 min) vers l'hôte de l'espace
 * (/support#t=…). L'échange ouvre une session d'espace de type « support » portée par un utilisateur SYNTHÉTIQUE
 * (« Assistance DelaiPay », rôle lecture seule) — aucun compte n'est créé dans l'espace, aucune limite n'est consommée.
 */
const crypto = require('crypto');
const { db, audit } = require('./db');
const { uid } = require('./util');

db.exec(`
CREATE TABLE IF NOT EXISTS support_access (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, admin_id TEXT, admin_email TEXT NOT NULL, motif TEXT NOT NULL,
  debut TEXT NOT NULL, fin TEXT NOT NULL, fin_effective TEXT, fin_motif TEXT,
  lien_hash TEXT, lien_expire TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_support_cab ON support_access(cabinet_id, debut);
`);
const MAX_MIN = 120, LINK_TTL_MS = 2 * 60e3;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sqlTime = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const ms = s => Date.parse(String(s).replace(' ', 'T') + 'Z');
const label = a => `Assistance DelaiPay (${a.admin_email})`;

function get(id) { return id ? db.prepare('SELECT * FROM support_access WHERE id=?').get(id) || null : null; }
function isActive(a, now = Date.now()) { return !!a && !a.fin_effective && ms(a.fin) > now; }
/** Clôt l'accès (une seule fois) : sessions fermées, journal de l'espace. */
function finish(a, motif) {
  const r = db.prepare(`UPDATE support_access SET fin_effective=datetime('now'), fin_motif=? WHERE id=? AND fin_effective IS NULL`).run(motif, a.id);
  if (!r.changes) return false;
  db.prepare(`UPDATE user_session SET ended_at=datetime('now'), end_reason='fin_support' WHERE support_access_id=? AND ended_at IS NULL`).run(a.id);
  audit(a.cabinet_id, null, 'acces_support_termine', 'espace_travail', { motif_fin: motif, ouvert_par: a.admin_email, par: label(a) }, null);
  return true;
}
/** Clôture des accès arrivés à échéance (appelée à la lecture et périodiquement). */
function sweep() {
  for (const a of db.prepare(`SELECT * FROM support_access WHERE fin_effective IS NULL AND fin <= ?`).all(sqlTime())) finish(a, 'durée écoulée');
}
const timer = setInterval(() => { try { sweep(); } catch (_) {} }, 60e3); if (timer.unref) timer.unref();

function newLink(a) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE support_access SET lien_hash=?, lien_expire=? WHERE id=?').run(sha256(token), sqlTime(Date.now() + LINK_TTL_MS), a.id);
  return token;
}
/** Ouvre un accès. @returns {{ access, token }} */
function open(cabinetId, admin, { motif, dureeMinutes }) {
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(cabinetId);
  if (!cab) throw Object.assign(new Error('Espace introuvable.'), { status: 404 });
  if (cab.actif === 0 || cab.supprime_le) throw Object.assign(new Error('Espace suspendu ou supprimé : accès d’assistance impossible.'), { status: 409 });
  const m = String(motif || '').trim();
  if (m.length < 5) throw Object.assign(new Error('Indiquez le motif de l’accès (5 caractères minimum) : il est visible par l’administrateur de l’espace.'), { status: 400 });
  const d = +dureeMinutes;
  if (!Number.isInteger(d) || d < 5 || d > MAX_MIN) throw Object.assign(new Error(`Durée : de 5 à ${MAX_MIN} minutes (2 heures au maximum).`), { status: 400 });
  sweep();
  if (db.prepare(`SELECT 1 FROM support_access WHERE cabinet_id=? AND admin_id=? AND fin_effective IS NULL AND fin > ?`).get(cabinetId, admin.id, sqlTime()))
    throw Object.assign(new Error('Un accès d’assistance est déjà en cours pour vous sur cet espace : terminez-le ou utilisez-le.'), { status: 409 });
  const id = uid('sup'), now = Date.now();
  db.prepare('INSERT INTO support_access (id, cabinet_id, admin_id, admin_email, motif, debut, fin) VALUES (?,?,?,?,?,?,?)')
    .run(id, cabinetId, admin.id, admin.email, m.slice(0, 500), sqlTime(now), sqlTime(now + d * 60e3));
  const a = get(id);
  audit(cabinetId, null, 'acces_support_ouvert', 'espace_travail', { motif: a.motif, debut: a.debut, fin_prevue: a.fin, duree_minutes: d, lecture_seule: true, par: label(a) }, null);
  return { access: a, token: newLink(a) };
}
function reissueLink(id, admin) {
  const a = get(id);
  if (!a || a.admin_id !== admin.id) throw Object.assign(new Error('Accès introuvable.'), { status: 404 });
  if (!isActive(a)) throw Object.assign(new Error('Cet accès est terminé.'), { status: 409 });
  return { access: a, token: newLink(a) };
}
function end(id, admin) {
  const a = get(id);
  if (!a) throw Object.assign(new Error('Accès introuvable.'), { status: 404 });
  if (!finish(a, `terminé par ${admin.email}`)) throw Object.assign(new Error('Cet accès est déjà terminé.'), { status: 409 });
  return get(id);
}
/** Échange du lien (hôte de l'espace) → session d'assistance en lecture seule. */
function exchange(token, hostCabinetId, req, res) {
  sweep();
  const a = token && String(token).length >= 20 ? db.prepare('SELECT * FROM support_access WHERE lien_hash=?').get(sha256(token)) : null;
  if (!a || !a.lien_expire || ms(a.lien_expire) <= Date.now() || !isActive(a)) return null;
  if (hostCabinetId !== undefined && hostCabinetId !== null && a.cabinet_id !== hostCabinetId) return null;
  db.prepare('UPDATE support_access SET lien_hash=NULL, lien_expire=NULL WHERE id=?').run(a.id); // usage unique
  const user = syntheticUser(a);
  require('./auth').issueSession(res, user, req, { type: 'support', supportAccessId: a.id, ttlMs: Math.max(60e3, ms(a.fin) - Date.now()) });
  audit(a.cabinet_id, null, 'acces_support_utilise', 'espace_travail', { ip: require('./net').clientIp(req), par: label(a) }, require('./net').clientIp(req));
  return a;
}
function syntheticUser(a) {
  return { id: 'support:' + a.id, cabinet_id: a.cabinet_id, nom: label(a), email: a.admin_email, role: 'lecture', initiales: 'DP', titre: 'Assistance DelaiPay', actif: 1 };
}
function listForCabinet(cabinetId, limit = 50) {
  sweep();
  return db.prepare('SELECT * FROM support_access WHERE cabinet_id=? ORDER BY debut DESC LIMIT ?').all(cabinetId, limit)
    .map(a => ({ id: a.id, admin: a.admin_email, motif: a.motif, debut: a.debut, fin: a.fin, finEffective: a.fin_effective, finMotif: a.fin_motif, actif: isActive(a) }));
}
function activeCount() { sweep(); return db.prepare(`SELECT COUNT(*) n FROM support_access WHERE fin_effective IS NULL AND fin > ?`).get(sqlTime()).n; }
function listActive() {
  sweep();
  return db.prepare(`SELECT s.*, c.slug FROM support_access s LEFT JOIN cabinet c ON c.id=s.cabinet_id WHERE s.fin_effective IS NULL AND s.fin > ? ORDER BY s.fin`).all(sqlTime());
}

module.exports = { open, reissueLink, end, exchange, get, isActive, syntheticUser, listForCabinet, activeCount, listActive, sweep, MAX_MIN, label };
