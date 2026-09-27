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
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')),
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

/** Journal filtrable (console) : espace, utilisateur, résultat, période. */
function list({ cabinetId = null, userId = null, resultat = null, depuisHeures = null, limit = 300 } = {}) {
  const w = ['1=1'], a = [];
  if (cabinetId) { w.push('e.cabinet_id=?'); a.push(cabinetId); }
  if (userId) { w.push('e.user_id=?'); a.push(userId); }
  if (resultat) { w.push('e.resultat=?'); a.push(resultat); }
  if (depuisHeures) { w.push(`e.created_at >= datetime('now', ?)`); a.push(`-${+depuisHeures} hours`); }
  return db.prepare(`SELECT e.*, c.slug, u.nom user_nom, u.role user_role FROM login_event e LEFT JOIN cabinet c ON c.id=e.cabinet_id LEFT JOIN utilisateur u ON u.id=e.user_id
      WHERE ${w.join(' AND ')} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`).all(...a, Math.min(1000, Math.max(1, +limit || 300)));
}
function counts24h(cabinetId = null) {
  const w = cabinetId ? 'AND cabinet_id=?' : '';
  const r = db.prepare(`SELECT resultat, COUNT(*) n FROM login_event WHERE created_at >= datetime('now','-24 hours') ${w} GROUP BY resultat`).all(...(cabinetId ? [cabinetId] : []));
  const o = { succes: 0, echec: 0, verrouillage: 0, bloque_politique: 0, appareil_en_attente: 0 };
  for (const x of r) o[x.resultat] = x.n;
  return o;
}
/**
 * Signaux à examiner (INFORMATIFS — aucun blocage automatique au-delà des verrouillages existants) :
 *  - nombreux échecs sur un même compte (≥ 5 en 1 h) ;
 *  - connexion réussie depuis un NOUVEAU pays pour l'utilisateur (base GeoIP locale requise) ;
 *  - nouvel appareil sur un compte administrateur (7 derniers jours).
 */
function signals({ cabinetId = null, jours = 7 } = {}) {
  const out = [];
  const cw = cabinetId ? 'AND e.cabinet_id=?' : '', ca = cabinetId ? [cabinetId] : [];
  for (const r of db.prepare(`SELECT e.email, e.cabinet_id, c.slug, COUNT(*) n, MAX(e.created_at) dernier, COUNT(DISTINCT e.ip) ips
      FROM login_event e LEFT JOIN cabinet c ON c.id=e.cabinet_id
      WHERE e.resultat IN ('echec','verrouillage') AND e.created_at >= datetime('now','-1 hours') AND e.email IS NOT NULL ${cw}
      GROUP BY e.email, e.cabinet_id HAVING COUNT(*) >= 5 ORDER BY n DESC`).all(...ca))
    out.push({ type: 'echecs_repetes', gravite: 'eleve', espace: { id: r.cabinet_id, slug: r.slug }, email: r.email, date: r.dernier,
      message: `${r.n} échecs de connexion en une heure sur ${r.email}${r.ips > 1 ? ` depuis ${r.ips} adresses IP` : ''}.` });
  for (const r of db.prepare(`SELECT e.*, c.slug FROM login_event e LEFT JOIN cabinet c ON c.id=e.cabinet_id
      WHERE e.resultat='succes' AND e.pays IS NOT NULL AND e.created_at >= datetime('now', ?) ${cw}
        AND EXISTS (SELECT 1 FROM login_event p WHERE p.user_id=e.user_id AND p.resultat='succes' AND p.pays IS NOT NULL AND p.created_at < e.created_at)
        AND NOT EXISTS (SELECT 1 FROM login_event p WHERE p.user_id=e.user_id AND p.resultat='succes' AND p.pays=e.pays AND p.created_at < e.created_at)
      ORDER BY e.created_at DESC LIMIT 50`).all(`-${jours} days`, ...ca))
    out.push({ type: 'nouveau_pays', gravite: 'moyen', espace: { id: r.cabinet_id, slug: r.slug }, email: r.email, date: r.created_at,
      message: `Connexion de ${r.email} depuis un nouveau pays (${r.pays}), IP ${r.ip}.` });
  for (const r of db.prepare(`SELECT d.*, u.email, c.slug FROM device d JOIN utilisateur u ON u.id=d.user_id LEFT JOIN cabinet c ON c.id=d.cabinet_id
      WHERE u.role='admin' AND d.first_seen >= datetime('now', ?) ${cabinetId ? 'AND d.cabinet_id=?' : ''}
        AND EXISTS (SELECT 1 FROM device o WHERE o.user_id=d.user_id AND o.first_seen < d.first_seen)
      ORDER BY d.first_seen DESC LIMIT 50`).all(`-${jours} days`, ...ca))
    out.push({ type: 'nouvel_appareil_admin', gravite: 'moyen', espace: { id: r.cabinet_id, slug: r.slug }, email: r.email, date: r.first_seen,
      message: `Nouvel appareil pour l’administrateur ${r.email} : ${[r.navigateur, r.os].filter(Boolean).join(' · ') || 'inconnu'} (IP ${r.derniere_ip || '—'}, statut ${r.statut}).` });
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

module.exports = { record, RESULTATS, list, counts24h, signals };
