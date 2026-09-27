'use strict';
/**
 * Sessions d'ESPACE côté serveur (INC 3A) — chaque jeton de connexion porte un identifiant de session (`sid`)
 * vérifié en base à chaque requête. Permet : déconnexion forcée, fin des sessions à la suspension d'un espace,
 * révocation d'un appareil, vue des sessions actives (console et Paramètres → Sécurité).
 *
 * Données de connexion (IP, navigateur, système, type et modèle d'appareil) : données personnelles au sens de la
 * loi 09-08, conservées selon la durée de rétention (12 mois par défaut) — voir DECISIONS.md et `npm run platform:purge`.
 */
const { db } = require('./db');
const { uid } = require('./util');
const ua = require('./useragent');
const geo = require('./geoip');
const { clientIp } = require('./net');

db.exec(`
CREATE TABLE IF NOT EXISTS user_session (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT,
  type TEXT NOT NULL DEFAULT 'utilisateur',     -- 'utilisateur' | 'support'
  support_access_id TEXT,
  ip TEXT, ip_derniere TEXT, pays TEXT, user_agent TEXT,
  navigateur TEXT, os TEXT, type_appareil TEXT, modele TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  ended_at TEXT, end_reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_usess_user ON user_session(user_id, ended_at);
CREATE INDEX IF NOT EXISTS ix_usess_cab ON user_session(cabinet_id, ended_at, last_seen_at);
CREATE INDEX IF NOT EXISTS ix_usess_dev ON user_session(device_id, ended_at);
`);

const sqlTime = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const TOUCH_MS = 60e3; // mise à jour de « vu pour la dernière fois » au plus une fois par minute

/** Ouvre une session (connexion réussie). req peut être absent (tests, outils). */
function open({ cabinetId, userId, deviceId = null, type = 'utilisateur', supportAccessId = null, ttlMs }, req) {
  const now = Date.now();
  const h = (req && req.headers) || {};
  const d = ua.describe(h);
  const ip = req ? clientIp(req) : null;
  const id = uid('ses');
  db.prepare(`INSERT INTO user_session (id, cabinet_id, user_id, device_id, type, support_access_id, ip, ip_derniere, pays, user_agent,
      navigateur, os, type_appareil, modele, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, cabinetId, userId, deviceId, type, supportAccessId, ip, ip, geo.country(ip), String(h['user-agent'] || '').slice(0, 300) || null,
      d.navigateur, d.os, d.type_appareil, d.modele, sqlTime(now), sqlTime(now), sqlTime(now + (ttlMs || 12 * 3600e3)));
  return id;
}
function get(id) { return id ? db.prepare('SELECT * FROM user_session WHERE id=?').get(id) || null : null; }
function isActive(s, now = Date.now()) { return !!s && !s.ended_at && Date.parse(s.expires_at.replace(' ', 'T') + 'Z') > now; }
/** Rafraîchit « vu pour la dernière fois » (au plus une fois par minute) et la dernière IP. */
function touch(s, req) {
  const ip = req ? clientIp(req) : null;
  const last = Date.parse(String(s.last_seen_at).replace(' ', 'T') + 'Z');
  if (Date.now() - last < TOUCH_MS && (!ip || ip === s.ip_derniere)) return;
  db.prepare('UPDATE user_session SET last_seen_at=?, ip_derniere=COALESCE(?, ip_derniere) WHERE id=?').run(sqlTime(), ip, s.id);
}
function end(id, reason) {
  return db.prepare(`UPDATE user_session SET ended_at=datetime('now'), end_reason=? WHERE id=? AND ended_at IS NULL`).run(reason || 'fin', id).changes;
}
function endForUser(userId, reason) {
  return db.prepare(`UPDATE user_session SET ended_at=datetime('now'), end_reason=? WHERE user_id=? AND ended_at IS NULL`).run(reason, userId).changes;
}
function endForCabinet(cabinetId, reason) {
  return db.prepare(`UPDATE user_session SET ended_at=datetime('now'), end_reason=? WHERE cabinet_id=? AND ended_at IS NULL`).run(reason, cabinetId).changes;
}
function endForDevice(deviceId, reason) {
  return db.prepare(`UPDATE user_session SET ended_at=datetime('now'), end_reason=? WHERE device_id=? AND ended_at IS NULL`).run(reason, deviceId).changes;
}
const ACTIVE_SQL = `ended_at IS NULL AND expires_at > datetime('now')`;
function activeCount(cabinetId) { return db.prepare(`SELECT COUNT(*) n FROM user_session WHERE cabinet_id=? AND ${ACTIVE_SQL}`).get(cabinetId).n; }

module.exports = { open, get, isActive, touch, end, endForUser, endForCabinet, endForDevice, activeCount, ACTIVE_SQL, sqlTime };
