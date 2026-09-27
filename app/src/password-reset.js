'use strict';
/**
 * Réinitialisation de mot de passe par LIEN À USAGE UNIQUE (INC 3A) — créé depuis la console, montré une seule fois,
 * valable 24 h, jeton stocké haché. À l'utilisation : nouveau mot de passe, toutes les sessions de l'utilisateur
 * fermées, inscription au journal de l'espace. Aucun envoi d'e-mail : le lien est transmis par l'opérateur.
 */
const crypto = require('crypto');
const { db, audit } = require('./db');
const { uid } = require('./util');

db.exec(`
CREATE TABLE IF NOT EXISTS password_reset (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), created_by TEXT, used_at TEXT, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_pwreset_user ON password_reset(user_id, created_at);
`);
const TTL_H = 24;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sqlTime = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function create(cabinetId, userId, byLabel) {
  const u = db.prepare('SELECT id, email FROM utilisateur WHERE id=? AND cabinet_id=?').get(userId, cabinetId);
  if (!u) { const e = new Error('Utilisateur introuvable.'); e.status = 404; throw e; }
  // Un seul lien valide à la fois : les précédents sont révoqués.
  db.prepare(`UPDATE password_reset SET revoked_at=datetime('now') WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL`).run(userId);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = sqlTime(Date.now() + TTL_H * 3600e3);
  db.prepare('INSERT INTO password_reset (id, cabinet_id, user_id, token_hash, expires_at, created_by) VALUES (?,?,?,?,?,?)')
    .run(uid('pwr'), cabinetId, userId, sha256(token), expires, byLabel || null);
  audit(cabinetId, null, 'lien_reinitialisation', 'utilisateur', { utilisateur: u.email, expire: expires, par: byLabel }, null);
  return { token, expires_at: expires, email: u.email };
}
/** Lien valide pour ce jeton ET pour l'espace désigné par l'hôte (si l'hôte en désigne un). */
function find(token, hostCabinetId) {
  if (!token || String(token).length < 20) return null;
  const r = db.prepare('SELECT * FROM password_reset WHERE token_hash=?').get(sha256(token));
  if (!r || r.used_at || r.revoked_at || r.expires_at < sqlTime()) return null;
  if (hostCabinetId !== undefined && hostCabinetId !== null && r.cabinet_id !== hostCabinetId) return null;
  const u = db.prepare('SELECT * FROM utilisateur WHERE id=?').get(r.user_id);
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(r.cabinet_id);
  if (!u || !u.actif || !cab || cab.actif === 0 || cab.supprime_le) return null;
  return { r, u, cab };
}
function complete(token, hostCabinetId, password, ip) {
  const f = find(token, hostCabinetId);
  if (!f) { const e = new Error('Ce lien de réinitialisation est invalide, expiré ou déjà utilisé.'); e.status = 410; throw e; }
  const pe = require('./workspace').passwordProblem(password);
  if (pe) { const e = new Error(pe); e.status = 400; throw e; }
  db.exec('BEGIN');
  try {
    const upd = db.prepare(`UPDATE password_reset SET used_at=datetime('now') WHERE id=? AND used_at IS NULL AND revoked_at IS NULL`).run(f.r.id);
    if (!upd.changes) { const e = new Error('Ce lien vient d’être utilisé.'); e.status = 410; throw e; }
    db.prepare('UPDATE utilisateur SET password_hash=? WHERE id=?').run(require('./auth').hashPassword(password), f.u.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const ended = require('./sessions').endForUser(f.u.id, 'mot_de_passe_reinitialise');
  audit(f.cab.id, f.u.id, 'reinitialisation_mot_de_passe', 'utilisateur', { utilisateur: f.u.email, sessions_fermees: ended }, ip);
  return f.u;
}

module.exports = { create, find, complete, TTL_H };
