'use strict';
/**
 * Console plateforme — schéma et accès aux données propres à l'OPÉRATEUR DelaiPay.
 *
 * Ces tables sont totalement séparées des comptes d'espace (`utilisateur`) : un administrateur plateforme
 * n'est jamais un utilisateur de cabinet et inversement. Aucune donnée comptable ici.
 *
 *   platform_admin          comptes opérateur (création par la ligne de commande uniquement)
 *   platform_recovery_code  codes de secours 2FA, à usage unique, stockés HACHÉS
 *   platform_session        sessions de la console (jeton opaque stocké haché, délais d'inactivité et absolu)
 *   platform_audit          journal de la plateforme — lecture seule (déclencheurs : ni UPDATE ni DELETE)
 *   platform_setting        réglages de la plateforme (liste d'IP de la console, maintenance, rétention…)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DB_PATH } = require('../db');
const { uid } = require('../util');

db.exec(`
CREATE TABLE IF NOT EXISTS platform_admin (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nom TEXT NOT NULL, password_hash TEXT NOT NULL,
  totp_secret_enc TEXT, totp_enabled INTEGER DEFAULT 0, totp_last_step INTEGER DEFAULT -1, totp_enrolled_at TEXT,
  actif INTEGER DEFAULT 1, echecs INTEGER DEFAULT 0, verrouille_jusqua TEXT,
  derniere_connexion TEXT, derniere_ip TEXT,
  created_at TEXT DEFAULT (datetime('now')), created_by TEXT
);
CREATE TABLE IF NOT EXISTS platform_recovery_code (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, code_hash TEXT NOT NULL, used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_prc_admin ON platform_recovery_code(admin_id);
CREATE TABLE IF NOT EXISTS platform_session (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  etape TEXT NOT NULL,                 -- 'mfa' (mot de passe vérifié, code attendu) | 'enrolement' | 'complete'
  pending_secret_enc TEXT, essais_code INTEGER DEFAULT 0,
  ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  ended_at TEXT, end_reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_psess_admin ON platform_session(admin_id, ended_at);
CREATE TABLE IF NOT EXISTS platform_audit (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
  admin_id TEXT, admin_email TEXT, action TEXT NOT NULL,
  cible_type TEXT, cible_id TEXT, cible_libelle TEXT,
  avant_json TEXT, apres_json TEXT, details_json TEXT,
  ip TEXT, user_agent TEXT
);
CREATE INDEX IF NOT EXISTS ix_paudit_date ON platform_audit(created_at);
CREATE INDEX IF NOT EXISTS ix_paudit_cible ON platform_audit(cible_type, cible_id, created_at);
CREATE TRIGGER IF NOT EXISTS tr_paudit_no_update BEFORE UPDATE ON platform_audit
  BEGIN SELECT RAISE(ABORT, 'platform_audit est en lecture seule'); END;
CREATE TRIGGER IF NOT EXISTS tr_paudit_no_delete BEFORE DELETE ON platform_audit
  BEGIN SELECT RAISE(ABORT, 'platform_audit est en lecture seule'); END;
CREATE TABLE IF NOT EXISTS platform_setting (
  cle TEXT PRIMARY KEY, valeur TEXT, updated_at TEXT DEFAULT (datetime('now')), updated_by TEXT
);
`);

/* ------------------------------------------------------------------ clé de chiffrement locale
 * Chiffre les secrets TOTP au repos (AES-256-GCM) et sert de « poivre » aux empreintes des codes de secours.
 * PLATFORM_SECRET_KEY (64 caractères hexadécimaux) en production ; sinon fichier .platform-key (0600)
 * à côté de la base. Perdre cette clé = ré-enrôler la 2FA des administrateurs (CLI --reset-2fa). */
function loadKey() {
  const env = process.env.PLATFORM_SECRET_KEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) throw new Error('PLATFORM_SECRET_KEY doit contenir 64 caractères hexadécimaux (32 octets).');
    return Buffer.from(env, 'hex');
  }
  const p = path.join(path.dirname(DB_PATH), '.platform-key');
  try { const k = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex'); if (k.length === 32) return k; } catch (_) {}
  const k = crypto.randomBytes(32);
  try { fs.writeFileSync(p, k.toString('hex'), { mode: 0o600 }); }
  catch (e) { if (process.env.NODE_ENV === 'production') throw new Error('PLATFORM_SECRET_KEY manquante et impossible à persister (.platform-key).'); }
  return k;
}
const KEY = loadKey();
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
function open(sealed) {
  const [v, iv, tag, enc] = String(sealed || '').split('.');
  if (v !== 'v1') throw new Error('Secret illisible');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const pepper = s => crypto.createHmac('sha256', KEY).update(String(s)).digest('hex');

/* ------------------------------------------------------------------ réglages */
function getSetting(cle, def = null) {
  const r = db.prepare('SELECT valeur FROM platform_setting WHERE cle=?').get(cle);
  if (!r) return def;
  try { return JSON.parse(r.valeur); } catch (_) { return def; }
}
function setSetting(cle, valeur, by) {
  db.prepare(`INSERT INTO platform_setting (cle, valeur, updated_at, updated_by) VALUES (?,?,datetime('now'),?)
              ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    .run(cle, JSON.stringify(valeur), by || null);
}

/* ------------------------------------------------------------------ journal plateforme (lecture seule) */
function paudit(actor, action, { type = null, id = null, libelle = null, avant, apres, details } = {}, req) {
  const j = v => (v === undefined ? null : JSON.stringify(v));
  db.prepare(`INSERT INTO platform_audit (id, admin_id, admin_email, action, cible_type, cible_id, cible_libelle, avant_json, apres_json, details_json, ip, user_agent)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid('pa'), actor ? actor.id : null, actor ? actor.email : null, action, type, id, libelle,
      j(avant), j(apres), j(details), req ? (require('../net').clientIp(req)) : null,
      req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 300) : null);
}
function listAudit({ limit = 100, before = null, cibleType = null, cibleId = null, action = null } = {}) {
  const w = [], a = [];
  if (before) { w.push('created_at < ?'); a.push(before); }
  if (cibleType) { w.push('cible_type = ?'); a.push(cibleType); }
  if (cibleId) { w.push('cible_id = ?'); a.push(cibleId); }
  if (action) { w.push('action = ?'); a.push(action); }
  const rows = db.prepare(`SELECT * FROM platform_audit ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(...a, Math.min(500, Math.max(1, +limit || 100)));
  const parse = s => { if (s == null) return null; try { return JSON.parse(s); } catch (_) { return s; } };
  return rows.map(r => ({ ...r, avant: parse(r.avant_json), apres: parse(r.apres_json), details: parse(r.details_json) }));
}

module.exports = { db, seal, open, sha256, pepper, getSetting, setSetting, paudit, listAudit };
