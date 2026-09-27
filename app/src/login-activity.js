'use strict';
/**
 * Activité de connexion des espaces (INC 3A) : succès, échecs, verrouillages, refus par la politique d'accès,
 * appareils en attente. Donnée personnelle (loi 09-08) soumise à la durée de rétention (DECISIONS.md).
 * N'enregistre JAMAIS le mot de passe saisi.
 */
const { db } = require('./db');
const { uid } = require('./util');
const ua = require('./useragent');
const geo = require('./geoip');
const { clientIp } = require('./net');

db.exec(`
CREATE TABLE IF NOT EXISTS login_event (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cabinet_id TEXT, user_id TEXT, email TEXT, resultat TEXT NOT NULL, motif TEXT,
  ip TEXT, pays TEXT, navigateur TEXT, os TEXT, type_appareil TEXT, device_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_lev_date ON login_event(created_at);
CREATE INDEX IF NOT EXISTS ix_lev_cab ON login_event(cabinet_id, created_at);
CREATE INDEX IF NOT EXISTS ix_lev_user ON login_event(user_id, created_at);
`);

/** resultat : succes | echec | verrouillage | bloque_politique | appareil_en_attente */
const RESULTATS = { succes: 'Connexion réussie', echec: 'Échec', verrouillage: 'Verrouillage', bloque_politique: 'Bloquée par la politique d’accès', appareil_en_attente: 'Appareil en attente' };
function record(req, { cabinetId = null, userId = null, email = null, resultat, motif = null, deviceId = null }) {
  try {
    const ip = clientIp(req), d = ua.describe((req && req.headers) || {});
    db.prepare(`INSERT INTO login_event (id, cabinet_id, user_id, email, resultat, motif, ip, pays, navigateur, os, type_appareil, device_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uid('lev'), cabinetId, userId, email ? String(email).toLowerCase().slice(0, 254) : null, resultat, motif ? String(motif).slice(0, 200) : null,
        ip, geo.country(ip), d.navigateur, d.os, d.type_appareil, deviceId);
  } catch (_) { /* la traçabilité ne doit jamais casser la connexion */ }
}

module.exports = { record, RESULTATS };
