'use strict';
/**
 * Rétention des données de connexion (INC 3A) — sessions terminées, appareils inactifs, activité de connexion.
 * Données personnelles (loi 09-08, déclaration CNDP, conditions d'utilisation) : durée configurable, 12 mois par défaut.
 *
 * NE TOUCHE JAMAIS : données comptables (clients, fournisseurs, factures, conventions, déclarations, visas…),
 * journal d'audit des espaces (audit_log), journal de la plateforme (platform_audit), comptes utilisateurs.
 * Purge uniquement par la ligne de commande (npm run platform:purge) — aucune purge automatique.
 */
const { db } = require('./db');
require('./sessions'); require('./devices'); require('./login-activity');

const DEFAULT_MONTHS = 12;
const TABLES = ['user_session', 'device', 'login_event']; // les SEULES tables que la purge peut modifier
function months() {
  const v = require('./platform/store').getSetting('retention_mois', null);
  const n = v == null ? DEFAULT_MONTHS : +v;
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : DEFAULT_MONTHS;
}
function setMonths(n, by) {
  const v = +n;
  if (!Number.isInteger(v) || v < 1 || v > 120) throw Object.assign(new Error('Durée de rétention : 1 à 120 mois.'), { status: 400 });
  require('./platform/store').setSetting('retention_mois', v, by);
  return v;
}
/** Lignes concernées, sans rien supprimer. */
function plan(m = months()) {
  const cut = `-${m} months`;
  return {
    mois: m,
    sessions: db.prepare(`SELECT COUNT(*) n FROM user_session WHERE (ended_at IS NOT NULL AND ended_at < datetime('now', ?)) OR (ended_at IS NULL AND expires_at < datetime('now', ?))`).get(cut, cut).n,
    // Appareil : dernière utilisation antérieure à la limite ET aucune session active.
    appareils: db.prepare(`SELECT COUNT(*) n FROM device d WHERE d.last_seen < datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM user_session s WHERE s.device_id=d.id AND s.ended_at IS NULL AND s.expires_at > datetime('now'))`).get(cut).n,
    connexions: db.prepare(`SELECT COUNT(*) n FROM login_event WHERE created_at < datetime('now', ?)`).get(cut).n,
  };
}
function purge(m = months()) {
  const cut = `-${m} months`;
  db.exec('BEGIN');
  try {
    const s = db.prepare(`DELETE FROM user_session WHERE (ended_at IS NOT NULL AND ended_at < datetime('now', ?)) OR (ended_at IS NULL AND expires_at < datetime('now', ?))`).run(cut, cut).changes;
    const d = db.prepare(`DELETE FROM device WHERE last_seen < datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM user_session s WHERE s.device_id=device.id AND s.ended_at IS NULL AND s.expires_at > datetime('now'))`).run(cut).changes;
    const l = db.prepare(`DELETE FROM login_event WHERE created_at < datetime('now', ?)`).run(cut).changes;
    db.exec('COMMIT');
    return { mois: m, sessions: s, appareils: d, connexions: l };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { months, setMonths, plan, purge, DEFAULT_MONTHS, TABLES };
