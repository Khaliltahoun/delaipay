'use strict';
/**
 * Politique d'accès d'un espace (INC 3A) — vérifiée à la CONNEXION et à CHAQUE requête.
 *
 *   Ouvert (défaut)        : mot de passe suffisant (les appareils sont enregistrés, statut « connu »).
 *   Appareils approuvés    : un appareil inconnu, même avec le bon mot de passe, est « en attente » jusqu'à
 *                            approbation par un administrateur de l'espace ou de la plateforme.
 *   Liste d'IP autorisées  : connexion et requêtes acceptées uniquement depuis les plages déclarées (CIDR + libellé).
 *   Les deux derniers modes se combinent. En plus : liste d'IP BLOQUÉES par espace et globale (plateforme).
 *
 * L'adresse IP est celle de la connexion TCP, ou celle transmise par un proxy DÉCLARÉ (TRUST_PROXY) — src/net.js.
 */
const { db } = require('./db');
const netu = require('./net');
const devices = require('./devices');

try { db.exec('ALTER TABLE cabinet ADD COLUMN acces_json TEXT'); } catch (_) {}

const DEFAULT = { appareils: false, ipAutorisees: false, listeIp: [], ipBloquees: [], dureeApprobationJours: null };
function policyOf(cab) {
  let p = {}; try { p = JSON.parse((cab && cab.acces_json) || '{}') || {}; } catch (_) {}
  return { ...DEFAULT, ...p, listeIp: Array.isArray(p.listeIp) ? p.listeIp : [], ipBloquees: Array.isArray(p.ipBloquees) ? p.ipBloquees : [] };
}
const modeLabel = p => p.appareils && p.ipAutorisees ? 'Appareils approuvés + liste d’IP' : p.appareils ? 'Appareils approuvés' : p.ipAutorisees ? 'Liste d’IP autorisées' : 'Ouvert';
function globalBlocklist() { return require('./platform/store').getSetting('ip_bloquees', []) || []; }

/** Valide une liste [{cidr, label}] ; renvoie la liste normalisée ou lève une erreur lisible. */
function normalizeList(list, what) {
  if (!Array.isArray(list)) return [];
  if (list.length > 200) throw Object.assign(new Error(`${what} : 200 entrées au maximum.`), { status: 400 });
  const seen = new Set(), out = [];
  for (const e of list) {
    const p = netu.parseCidr(typeof e === 'string' ? e : e && e.cidr);
    if (!p.ok) throw Object.assign(new Error(`${what} — ${p.error}`), { status: 400 });
    if (seen.has(p.cidr)) continue; seen.add(p.cidr);
    out.push({ cidr: p.cidr, label: String((e && e.label) || '').trim().slice(0, 60) || null });
  }
  return out;
}
function validatePolicy(b, current) {
  const next = { ...current };
  if (b.appareils !== undefined) next.appareils = !!b.appareils;
  if (b.ipAutorisees !== undefined) next.ipAutorisees = !!b.ipAutorisees;
  if (b.listeIp !== undefined) next.listeIp = normalizeList(b.listeIp, 'Liste d’IP autorisées');
  if (b.ipBloquees !== undefined) next.ipBloquees = normalizeList(b.ipBloquees, 'Liste d’IP bloquées');
  if (b.dureeApprobationJours !== undefined) {
    const v = b.dureeApprobationJours;
    if (v == null || v === '') next.dureeApprobationJours = null;
    else { const n = +v; if (!Number.isInteger(n) || n < 1 || n > 730) throw Object.assign(new Error('Durée d’approbation : 1 à 730 jours, ou vide (sans expiration).'), { status: 400 }); next.dureeApprobationJours = n; }
  }
  if (next.ipAutorisees && !next.listeIp.length) throw Object.assign(new Error('Ajoutez au moins une adresse ou plage avant d’activer la liste d’IP autorisées.'), { status: 400 });
  return next;
}

const MSG = {
  ip_bloquee: 'Connexion refusée depuis cette adresse IP.',
  ip_non_autorisee: 'Connexion impossible depuis ce réseau : votre espace n’autorise que certaines adresses IP. Contactez l’administrateur de votre espace.',
  appareil_en_attente: 'Cet appareil doit être approuvé par l’administrateur de votre espace.',
  appareil_refuse: 'L’accès depuis cet appareil a été refusé par l’administrateur de votre espace.',
  appareil_expire: 'L’approbation de cet appareil a expiré : elle doit être renouvelée par l’administrateur de votre espace.',
};
function ipDecision(ip, p) {
  if (netu.ipInList(ip, globalBlocklist()) || netu.ipInList(ip, p.ipBloquees)) return 'ip_bloquee';
  if (p.ipAutorisees && !netu.ipInList(ip, p.listeIp)) return 'ip_non_autorisee';
  return null;
}

/**
 * Connexion (mot de passe déjà vérifié) : IP puis appareil. Enregistre / met à jour l'appareil (cookie).
 * @returns {{ ok:true, device } | { ok:false, code, error, device? }}
 */
function evaluateLogin(req, res, user, cab) {
  const p = policyOf(cab);
  const ipCode = ipDecision(netu.clientIp(req), p);
  if (ipCode) return { ok: false, code: ipCode, error: MSG[ipCode] };
  let d = devices.fromRequest(req, user);
  if (!p.appareils) {
    if (!d || d.statut === 'revoque' || d.statut === 'refuse') d = devices.create(req, res, user, 'connu'); else devices.seen(d, req);
    return { ok: true, device: d };
  }
  if (!d || d.statut === 'revoque') d = devices.create(req, res, user, 'en_attente');
  else devices.seen(d, req);
  if (d.statut === 'approuve' && devices.isExpired(d)) {
    db.prepare(`UPDATE device SET statut='en_attente', motif='approbation expirée' WHERE id=?`).run(d.id);
    return { ok: false, code: 'appareil_expire', error: MSG.appareil_expire, device: devices.get(d.id) };
  }
  if (d.statut === 'approuve') return { ok: true, device: d };
  if (d.statut === 'refuse') return { ok: false, code: 'appareil_refuse', error: MSG.appareil_refuse, device: d };
  if (d.statut === 'connu') db.prepare(`UPDATE device SET statut='en_attente' WHERE id=?`).run(d.id); // politique activée depuis
  return { ok: false, code: 'appareil_en_attente', error: MSG.appareil_en_attente, device: devices.get(d.id) };
}

/** À chaque requête authentifiée : IP courante et appareil de la session. @returns null (autorisé) ou { reason, error } */
function checkRequest(req, sess, cab) {
  const p = policyOf(cab);
  const ipCode = ipDecision(netu.clientIp(req), p);
  if (ipCode) return { reason: ipCode, error: MSG[ipCode] };
  if (p.appareils && sess.type !== 'support') {
    const d = devices.get(sess.device_id);
    if (!d || d.statut !== 'approuve') return { reason: d && d.statut === 'refuse' ? 'appareil_refuse' : 'appareil_en_attente', error: d && d.statut === 'refuse' ? MSG.appareil_refuse : MSG.appareil_en_attente };
    if (devices.isExpired(d)) return { reason: 'appareil_expire', error: MSG.appareil_expire };
  }
  return null;
}

/**
 * Enregistre une nouvelle politique. Protection contre l'auto-blocage :
 *  - activation des « appareils approuvés » : l'appareil COURANT de l'administrateur qui l'active est approuvé
 *    (et, sur demande, tous les appareils déjà connus des utilisateurs actifs) ;
 *  - liste d'IP : depuis l'espace, refusée si l'IP courante de l'administrateur n'y figure pas.
 * @returns {{ avant, apres, approuves:number, avertissements:string[] }}
 */
function savePolicy(cabinetId, body, { actorLabel, currentIp = null, currentDeviceId = null, requireCurrentIp = false } = {}) {
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(cabinetId);
  const avant = policyOf(cab);
  const apres = validatePolicy(body || {}, avant);
  const avertissements = [];
  if (apres.ipAutorisees) {
    const inList = currentIp && netu.ipInList(currentIp, apres.listeIp);
    if (requireCurrentIp && !inList) throw Object.assign(new Error(`Votre adresse IP actuelle (${currentIp || 'inconnue'}) n’est pas dans la liste : ajoutez-la, sinon vous seriez bloqué·e.`), { status: 400, code: 'auto_blocage' });
    const admins = db.prepare(`SELECT u.email, (SELECT ip_derniere FROM user_session s WHERE s.user_id=u.id ORDER BY s.last_seen_at DESC LIMIT 1) ip
      FROM utilisateur u WHERE u.cabinet_id=? AND u.role='admin' AND u.actif=1`).all(cabinetId);
    const outside = admins.filter(a => a.ip && !netu.ipInList(a.ip, apres.listeIp));
    if (outside.length) avertissements.push(`Dernière IP hors liste pour : ${outside.map(a => `${a.email} (${a.ip})`).join(', ')}.`);
    if (!admins.some(a => a.ip && netu.ipInList(a.ip, apres.listeIp))) avertissements.push('Aucun administrateur de l’espace ne s’est connecté récemment depuis une adresse de la liste : risque de blocage.');
    if (currentIp && !inList && !requireCurrentIp) avertissements.push(`Votre adresse IP (${currentIp}) n’est pas dans la liste (sans effet sur la console).`);
  }
  if (netu.ipInList(currentIp, apres.ipBloquees)) throw Object.assign(new Error(`Votre adresse IP actuelle (${currentIp}) est dans la liste des IP bloquées.`), { status: 400, code: 'auto_blocage' });
  let approuves = 0;
  if (apres.appareils && !avant.appareils) {
    if (currentDeviceId) { devices.decide(currentDeviceId, 'approuve', actorLabel + ' (activation, appareil courant)', { dureeJours: apres.dureeApprobationJours }); approuves++; }
    if (body.approuverAppareilsConnus) {
      const ids = db.prepare(`SELECT d.id FROM device d JOIN utilisateur u ON u.id=d.user_id WHERE d.cabinet_id=? AND u.actif=1 AND d.statut='connu'`).all(cabinetId).map(r => r.id);
      for (const id of ids) if (id !== currentDeviceId) { devices.decide(id, 'approuve', actorLabel + ' (activation, appareils connus)', { dureeJours: apres.dureeApprobationJours }); approuves++; }
    }
  }
  db.prepare(`UPDATE cabinet SET acces_json=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(apres), cabinetId);
  // Les sessions devenues non conformes seront fermées à leur prochaine requête (vérification à chaque requête).
  return { avant, apres, approuves, avertissements };
}

module.exports = { policyOf, modeLabel, validatePolicy, evaluateLogin, checkRequest, savePolicy, normalizeList, globalBlocklist, MSG, DEFAULT };
