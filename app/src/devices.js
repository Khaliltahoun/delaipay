'use strict';
/**
 * Appareils (INC 3A) — un appareil = un navigateur identifié par un jeton ALÉATOIRE posé en cookie httpOnly
 * (Secure en HTTPS, SameSite=Lax, limité à l'hôte de l'espace), stocké HACHÉ en base et lié à UN utilisateur
 * d'UN espace. L'adresse IP n'identifie jamais un appareil : un appareil approuvé reste approuvé quand l'IP change.
 *
 * Statuts : connu (espace « ouvert ») · en_attente · approuve · refuse · revoque.
 */
const crypto = require('crypto');
const { db } = require('./db');
const { uid } = require('./util');
const ua = require('./useragent');
const geo = require('./geoip');
const { clientIp } = require('./net');

db.exec(`
CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  statut TEXT NOT NULL DEFAULT 'connu',
  navigateur TEXT, os TEXT, type_appareil TEXT, modele TEXT,
  premiere_ip TEXT, derniere_ip TEXT, pays TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  decide_par TEXT, decide_le TEXT, expire_le TEXT, motif TEXT
);
CREATE INDEX IF NOT EXISTS ix_device_user ON device(user_id, statut);
CREATE INDEX IF NOT EXISTS ix_device_cab ON device(cabinet_id, statut, last_seen);
`);

const PROD = process.env.NODE_ENV === 'production';
const SECURE = process.env.COOKIE_SECURE != null ? process.env.COOKIE_SECURE === '1' : PROD;
const COOKIE_MAX_AGE = 400 * 86400e3; // plafond des navigateurs
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const sqlTime = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
/** Un cookie par utilisateur (deux collègues sur le même navigateur ne s'écrasent pas). */
const cookieName = userId => 'dp_dev_' + sha256('dev:' + userId).slice(0, 12);

function fromRequest(req, user) {
  const tok = req.cookies && req.cookies[cookieName(user.id)];
  if (!tok || typeof tok !== 'string' || tok.length < 20) return null;
  const d = db.prepare('SELECT * FROM device WHERE token_hash=?').get(sha256(tok));
  // Lié à l'utilisateur ET à l'espace : un jeton copié vers un autre compte ou un autre espace est inconnu.
  if (!d || d.user_id !== user.id || d.cabinet_id !== user.cabinet_id) return null;
  return d;
}
function get(id) { return id ? db.prepare('SELECT * FROM device WHERE id=?').get(id) || null : null; }
function isExpired(d) { return !!(d && d.expire_le && d.expire_le < sqlTime()); }

/** Nouvel appareil (jeton posé en cookie). */
function create(req, res, user, statut) {
  const token = crypto.randomBytes(32).toString('base64url');
  const d = ua.describe(req.headers || {}), ip = clientIp(req), now = sqlTime();
  const id = uid('dev');
  db.prepare(`INSERT INTO device (id, cabinet_id, user_id, token_hash, statut, navigateur, os, type_appareil, modele, premiere_ip, derniere_ip, pays, first_seen, last_seen)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, user.cabinet_id, user.id, sha256(token), statut, d.navigateur, d.os, d.type_appareil, d.modele, ip, ip, geo.country(ip), now, now);
  res.cookie(cookieName(user.id), token, { httpOnly: true, secure: SECURE, sameSite: 'lax', path: '/', maxAge: COOKIE_MAX_AGE });
  return get(id);
}
/** Vu à nouveau (connexion) : dernière IP, navigateur, modèle (si l'indice client est présent). */
function seen(d, req) {
  const u = ua.describe(req.headers || {}), ip = clientIp(req);
  db.prepare(`UPDATE device SET last_seen=?, derniere_ip=COALESCE(?, derniere_ip), pays=COALESCE(?, pays), navigateur=COALESCE(?, navigateur), os=COALESCE(?, os),
              type_appareil=COALESCE(?, type_appareil), modele=COALESCE(?, modele) WHERE id=?`)
    .run(sqlTime(), ip, geo.country(ip), u.navigateur, u.os, u.type_appareil, u.modele, d.id);
}
function decide(id, statut, by, { motif = null, dureeJours = null } = {}) {
  const expire = statut === 'approuve' && dureeJours ? sqlTime(Date.now() + dureeJours * 86400e3) : null;
  db.prepare('UPDATE device SET statut=?, decide_par=?, decide_le=datetime(\'now\'), expire_le=?, motif=? WHERE id=?').run(statut, by || null, expire, motif, id);
  let ended = 0;
  if (statut === 'refuse' || statut === 'revoque') ended = require('./sessions').endForDevice(id, 'appareil_revoque');
  return { sessions: ended };
}
function revokeAllForUser(userId, by) {
  const ids = db.prepare(`SELECT id FROM device WHERE user_id=? AND statut NOT IN ('revoque','refuse')`).all(userId).map(r => r.id);
  let sessions = 0;
  for (const id of ids) sessions += decide(id, 'revoque', by).sessions;
  // Les sessions sans appareil enregistré de cet utilisateur sont aussi fermées (révocation = accès coupé).
  sessions += require('./sessions').endForUser(userId, 'appareil_revoque');
  return { appareils: ids.length, sessions };
}
function countForUser(userId) { return db.prepare(`SELECT COUNT(*) n FROM device WHERE user_id=? AND statut NOT IN ('revoque','refuse')`).get(userId).n; }
function listForCabinet(cabinetId, { statut = null } = {}) {
  return db.prepare(`SELECT d.*, u.nom user_nom, u.email user_email, u.role user_role FROM device d JOIN utilisateur u ON u.id=d.user_id
      WHERE d.cabinet_id=? ${statut ? 'AND d.statut=?' : ''} ORDER BY (d.statut='en_attente') DESC, d.last_seen DESC LIMIT 500`).all(...[cabinetId, statut].filter(v => v != null));
}
const STATUT_FR = { connu: 'Connu', en_attente: 'En attente d’approbation', approuve: 'Approuvé', refuse: 'Refusé', revoque: 'Révoqué' };
function publicDevice(d) {
  return { id: d.id, statut: d.statut, statutLabel: STATUT_FR[d.statut] || d.statut, navigateur: d.navigateur, os: d.os, type: d.type_appareil,
    modele: d.modele, premiereIp: d.premiere_ip, derniereIp: d.derniere_ip, pays: d.pays, firstSeen: d.first_seen, lastSeen: d.last_seen,
    decidePar: d.decide_par, decideLe: d.decide_le, expireLe: d.expire_le, expire: isExpired(d),
    utilisateur: d.user_email ? { id: d.user_id, nom: d.user_nom, email: d.user_email, role: d.user_role } : undefined };
}

module.exports = { cookieName, fromRequest, get, create, seen, decide, revokeAllForUser, countForUser, listForCabinet, publicDevice, isExpired, STATUT_FR };
