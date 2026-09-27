'use strict';
/**
 * Console plateforme — comptes opérateur, 2FA TOTP obligatoire, sessions courtes.
 *
 * Séparation stricte avec les espaces de travail :
 *  - cookie distinct (`__Host-dp_console` en HTTPS, `dp_console` en local), limité à l'hôte de la console
 *    (aucun attribut Domain), SameSite=Strict, httpOnly ;
 *  - jeton OPAQUE (aléatoire, stocké haché en base), jamais un JWT d'espace : un cookie d'espace présenté
 *    à la console, ou un cookie de console présenté à un espace, est simplement inconnu.
 *  - délai d'inactivité (PLATFORM_IDLE_MINUTES, 15 min) et durée absolue (PLATFORM_SESSION_HOURS, 8 h).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');
const totp = require('./totp');
const { uid } = require('../util');
const { clientIp } = require('../net');
const { db } = store;

const PROD = process.env.NODE_ENV === 'production';
const SECURE = process.env.COOKIE_SECURE != null ? process.env.COOKIE_SECURE === '1' : PROD;
const COOKIE = SECURE ? '__Host-dp_console' : 'dp_console';
const IDLE_MIN = Math.max(1, +process.env.PLATFORM_IDLE_MINUTES || 15);
const ABSOLUTE_H = Math.max(1, +process.env.PLATFORM_SESSION_HOURS || 8);
const STEP_MIN = { mfa: 5, enrolement: 10 };        // durée maximale des étapes intermédiaires
const MAX_CODE_TRIES = 5;                            // essais de code par session d'étape
const LOCK_AFTER = 8, LOCK_MIN = 30;                 // verrouillage du compte après 8 échecs consécutifs
const PASSWORD_MIN = 14;
const DUMMY = bcrypt.hashSync('dp_platform_dummy_for_timing', 12);
const GENERIC = 'Identifiants incorrects.';

const sqlTime = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseSql = s => Date.parse(String(s).replace(' ', 'T') + 'Z');

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`;
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw) || !/[^a-z0-9]/i.test(pw)) return 'Le mot de passe doit mêler lettres, chiffres et au moins un caractère spécial.';
  return null;
}

/* ------------------------------------------------------------------ comptes (CLI uniquement pour la création) */
function createAdmin({ email, nom, password }, actor = 'cli') {
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('Adresse e-mail invalide.');
  const n = String(nom || '').trim(); if (!n) throw new Error('Nom requis.');
  const pe = passwordProblem(password); if (pe) throw new Error(pe);
  if (db.prepare('SELECT 1 FROM platform_admin WHERE email=?').get(mail)) throw new Error('Un administrateur plateforme existe déjà pour cette adresse.');
  const id = uid('padm');
  db.prepare(`INSERT INTO platform_admin (id, email, nom, password_hash, created_by) VALUES (?,?,?,?,?)`)
    .run(id, mail, n, bcrypt.hashSync(password, 12), actor);
  store.paudit({ id: null, email: actor }, 'admin_plateforme_cree', { type: 'platform_admin', id, libelle: mail, apres: { email: mail, nom: n } });
  return { id, email: mail, nom: n };
}
function adminById(id) { return db.prepare('SELECT * FROM platform_admin WHERE id=?').get(id) || null; }
function publicAdmin(a) { return a ? { id: a.id, email: a.email, nom: a.nom, totpEnabled: !!a.totp_enabled, derniereConnexion: a.derniere_connexion } : null; }

/* ------------------------------------------------------------------ codes de secours */
const RC_ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRecoveryCode() {
  const b = crypto.randomBytes(10); let s = '';
  for (let i = 0; i < 10; i++) s += RC_ALPHA[b[i] % RC_ALPHA.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normRc = c => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function regenerateRecoveryCodes(adminId) {
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM platform_recovery_code WHERE admin_id=?').run(adminId);
    const ins = db.prepare('INSERT INTO platform_recovery_code (id, admin_id, code_hash) VALUES (?,?,?)');
    for (const c of codes) ins.run(uid('prc'), adminId, store.pepper(normRc(c)));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return codes; // affichés UNE seule fois
}
function useRecoveryCode(adminId, code) {
  const h = store.pepper(normRc(code));
  const r = db.prepare(`UPDATE platform_recovery_code SET used_at=datetime('now') WHERE admin_id=? AND code_hash=? AND used_at IS NULL`).run(adminId, h);
  return r.changes === 1;
}
function remainingRecoveryCodes(adminId) {
  return db.prepare('SELECT COUNT(*) n FROM platform_recovery_code WHERE admin_id=? AND used_at IS NULL').get(adminId).n;
}

/* ------------------------------------------------------------------ sessions */
function newSession(adminId, etape, req, extra = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const exp = etape === 'complete' ? now + ABSOLUTE_H * 3600e3 : now + STEP_MIN[etape] * 60e3;
  const id = uid('psess');
  db.prepare(`INSERT INTO platform_session (id, admin_id, token_hash, etape, pending_secret_enc, ip, user_agent, created_at, last_seen_at, expires_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, adminId, store.sha256(token), etape, extra.pendingSecretEnc || null, clientIp(req),
      String((req.headers && req.headers['user-agent']) || '').slice(0, 300), sqlTime(now), sqlTime(now), sqlTime(exp));
  return { id, token };
}
function endSession(id, reason) {
  db.prepare(`UPDATE platform_session SET ended_at=datetime('now'), end_reason=? WHERE id=? AND ended_at IS NULL`).run(reason || 'fin', id);
}
function setCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: SECURE, sameSite: 'strict', path: '/' }); // cookie de session (pas de maxAge)
}
function clearCookie(res) { res.clearCookie(COOKIE, { httpOnly: true, secure: SECURE, sameSite: 'strict', path: '/' }); }

/** Lit et valide la session de console de la requête. @returns {{session, admin}|{error, code}} */
function readSession(req, { touch = true } = {}) {
  const tok = req.cookies && req.cookies[COOKIE];
  if (!tok || typeof tok !== 'string' || tok.length < 20) return { code: 'aucune_session' };
  const s = db.prepare('SELECT * FROM platform_session WHERE token_hash=?').get(store.sha256(tok));
  if (!s || s.ended_at) return { code: 'session_inconnue' };
  const now = Date.now();
  if (parseSql(s.expires_at) <= now) { endSession(s.id, 'duree_maximale'); return { code: 'session_expiree' }; }
  if (s.etape === 'complete' && parseSql(s.last_seen_at) + IDLE_MIN * 60e3 <= now) { endSession(s.id, 'inactivite'); return { code: 'session_expiree' }; }
  const a = adminById(s.admin_id);
  if (!a || !a.actif) { endSession(s.id, 'compte_desactive'); return { code: 'session_inconnue' }; }
  if (touch && s.etape === 'complete') db.prepare('UPDATE platform_session SET last_seen_at=? WHERE id=?').run(sqlTime(now), s.id);
  return { session: s, admin: a };
}

/** Middleware : exige une session COMPLÈTE (mot de passe + code). */
function requireConsole(req, res, next) {
  const r = readSession(req);
  if (!r.session || r.session.etape !== 'complete') {
    if (r.code && r.code !== 'aucune_session') clearCookie(res);   // session invalide : retirée ; étape en cours : conservée
    return res.status(401).json({ error: r.code === 'session_expiree' ? 'Votre session a expiré. Reconnectez-vous.' : 'Authentification requise.', code: r.code || 'etape_incomplete' });
  }
  req.padmin = r.admin; req.psession = r.session;
  res.setHeader('X-DP-Console-Idle', String(IDLE_MIN * 60));
  next();
}

/* ------------------------------------------------------------------ étapes de connexion */
function isLocked(a) { return a && a.verrouille_jusqua && parseSql(a.verrouille_jusqua) > Date.now(); }
function recordFailure(a) {
  if (!a) return;
  const n = (a.echecs || 0) + 1;
  db.prepare('UPDATE platform_admin SET echecs=?, verrouille_jusqua=? WHERE id=?')
    .run(n, n >= LOCK_AFTER ? sqlTime(Date.now() + LOCK_MIN * 60e3) : a.verrouille_jusqua, a.id);
  return n >= LOCK_AFTER;
}

/** Étape 1 : e-mail + mot de passe. @returns {{ok:true, next, session}|{ok:false}} (message toujours générique) */
function passwordStep(email, password, req) {
  const mail = String(email || '').trim().toLowerCase();
  const a = db.prepare('SELECT * FROM platform_admin WHERE email=?').get(mail);
  const ok = bcrypt.compareSync(String(password || ''), a ? a.password_hash : DUMMY);
  if (!a || !a.actif || !ok || isLocked(a)) {
    const locked = a && ok === false ? recordFailure(a) : false;
    store.paudit(a ? { id: a.id, email: a.email } : { id: null, email: mail.slice(0, 254) }, 'connexion_console_refusee',
      { type: 'platform_admin', id: a ? a.id : null, libelle: mail.slice(0, 254),
        details: { motif: !a ? 'compte inconnu' : !a.actif ? 'compte désactivé' : isLocked(a) ? 'compte verrouillé' : 'mot de passe incorrect', verrouillage: !!locked } }, req);
    return { ok: false };
  }
  if (a.totp_enabled) return { ok: true, next: 'totp', session: newSession(a.id, 'mfa', req), admin: a };
  const secret = totp.generateSecret();
  return { ok: true, next: 'enrolement', session: newSession(a.id, 'enrolement', req, { pendingSecretEnc: store.seal(secret) }), admin: a };
}

/** Données d'enrôlement (session à l'étape « enrolement ») : QR SVG généré localement + secret en clair. */
function enrolmentData(session, admin) {
  const secret = store.open(session.pending_secret_enc);
  const uri = totp.otpauthUri({ secret, account: admin.email });
  return { secret, secretGroups: secret.match(/.{1,4}/g).join(' '), uri, qrSvg: require('./qr').toSvg(uri) };
}

function countTry(session) {
  const n = (session.essais_code || 0) + 1;
  db.prepare('UPDATE platform_session SET essais_code=? WHERE id=?').run(n, session.id);
  if (n >= MAX_CODE_TRIES) endSession(session.id, 'trop_de_codes');
  return n;
}
/** Promotion en session complète : nouveau jeton (anti-fixation), l'ancien est clos. */
function promote(session, admin, req, res) {
  endSession(session.id, 'etape_suivante');
  const s = newSession(admin.id, 'complete', req);
  db.prepare(`UPDATE platform_admin SET echecs=0, verrouille_jusqua=NULL, derniere_connexion=datetime('now'), derniere_ip=? WHERE id=?`).run(clientIp(req), admin.id);
  setCookie(res, s.token);
  return s;
}

/** Étape 2a : premier enrôlement — le code doit correspondre au secret en attente. */
function confirmEnrolment(session, admin, code, req, res) {
  const secret = store.open(session.pending_secret_enc);
  const step = totp.verify(secret, code);
  if (step == null) {
    countTry(session); recordFailure(admin);
    store.paudit(admin, 'enrolement_2fa_refuse', { type: 'platform_admin', id: admin.id, libelle: admin.email, details: { motif: 'code incorrect' } }, req);
    return { ok: false };
  }
  db.prepare(`UPDATE platform_admin SET totp_secret_enc=?, totp_enabled=1, totp_last_step=?, totp_enrolled_at=datetime('now') WHERE id=?`)
    .run(store.seal(secret), step, admin.id);
  const codes = regenerateRecoveryCodes(admin.id);
  store.paudit(admin, 'enrolement_2fa', { type: 'platform_admin', id: admin.id, libelle: admin.email, details: { codes_de_secours: codes.length } }, req);
  promote(session, admin, req, res);
  store.paudit(admin, 'connexion_console', { type: 'platform_admin', id: admin.id, libelle: admin.email, details: { methode: 'enrôlement 2FA' } }, req);
  return { ok: true, recoveryCodes: codes };
}

/** Étape 2b : code TOTP (ou code de secours à usage unique). */
function codeStep(session, admin, { code, recoveryCode }, req, res) {
  let method = null;
  if (recoveryCode) {
    if (useRecoveryCode(admin.id, recoveryCode)) method = 'code de secours';
  } else {
    const secret = store.open(admin.totp_secret_enc);
    const step = totp.verify(secret, code, { lastStep: admin.totp_last_step });
    if (step != null) { db.prepare('UPDATE platform_admin SET totp_last_step=? WHERE id=?').run(step, admin.id); method = 'TOTP'; }
  }
  if (!method) {
    const tries = countTry(session); recordFailure(admin);
    store.paudit(admin, 'connexion_console_refusee', { type: 'platform_admin', id: admin.id, libelle: admin.email,
      details: { motif: recoveryCode ? 'code de secours invalide' : 'code 2FA incorrect', essai: tries } }, req);
    return { ok: false };
  }
  promote(session, admin, req, res);
  store.paudit(admin, 'connexion_console', { type: 'platform_admin', id: admin.id, libelle: admin.email,
    details: { methode: method, ...(method === 'code de secours' ? { codes_restants: remainingRecoveryCodes(admin.id) } : {}) } }, req);
  return { ok: true, method, remaining: remainingRecoveryCodes(admin.id) };
}

module.exports = {
  COOKIE, IDLE_MIN, ABSOLUTE_H, GENERIC, PASSWORD_MIN, passwordProblem, createAdmin, adminById, publicAdmin,
  regenerateRecoveryCodes, remainingRecoveryCodes, readSession, requireConsole, passwordStep, enrolmentData,
  confirmEnrolment, codeStep, endSession, setCookie, clearCookie, sqlTime, parseSql,
};
