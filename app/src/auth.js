'use strict';
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const PROD = process.env.NODE_ENV === 'production';

// Secret : variable d'env en prod, sinon persistée localement.
// En production, on exige un secret stable (env ou fichier persistant) : sinon
// chaque redémarrage invaliderait toutes les sessions — on échoue explicitement.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Secret persistant à côté de la BASE (et non du code) : survit aux déploiements par versions (releases/<id>).
  const p = path.join(path.dirname(require('./db').DB_PATH), '.secret');
  try { return fs.readFileSync(p, 'utf8'); }
  catch (_) {
    const s = require('crypto').randomBytes(48).toString('hex');
    try { fs.writeFileSync(p, s, { mode: 0o600 }); }
    catch (err) {
      if (PROD) throw new Error('JWT_SECRET manquant et impossible à persister (data/.secret). Définissez JWT_SECRET.');
    }
    return s;
  }
}
const SECRET = loadSecret();
const COOKIE = 'dp_token';
const MAXAGE = 1000 * 60 * 60 * 12; // 12 h

// Cookie Secure par défaut en prod ; surchargeable via COOKIE_SECURE (0/1) sans
// dépendre uniquement de NODE_ENV.
const COOKIE_SECURE = process.env.COOKIE_SECURE != null
  ? process.env.COOKIE_SECURE === '1'
  : PROD;

// Hash factice pour égaliser le temps de réponse quand l'utilisateur n'existe pas
// (empêche l'énumération de comptes par timing).
const DUMMY_HASH = bcrypt.hashSync('dp_dummy_password_for_timing', 10);

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function verifyPassword(pw, hash) { try { return bcrypt.compareSync(pw, hash); } catch { return false; } }

/**
 * Jeton d'espace. Chaque jeton porte l'identifiant d'une session ENREGISTRÉE en base (`sid`) : sans session
 * active correspondante, le jeton est refusé (déconnexion forcée, suspension, révocation d'appareil — INC 3A).
 * Sans `sid` fourni, une session est ouverte ici (outils, tests).
 */
function signToken(user, opts = {}) {
  const sid = opts.sid || require('./sessions').open({ cabinetId: user.cabinet_id, userId: user.id }, opts.req);
  return jwt.sign(
    { uid: user.id, cid: user.cabinet_id, sid, role: user.role, email: user.email, nom: user.nom, ini: user.initiales },
    SECRET, { expiresIn: '12h' });
}
const COOKIE_OPTS = {
  httpOnly: true, sameSite: 'lax', path: '/',
  secure: COOKIE_SECURE,
};
function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, { ...COOKIE_OPTS, maxAge: MAXAGE });
}
function clearAuthCookie(res) { res.clearCookie(COOKIE, COOKIE_OPTS); }
/** Connexion réussie : ouvre une session serveur (IP, navigateur, appareil) et pose le cookie. @returns sid */
function issueSession(res, user, req, opts = {}) {
  const sid = require('./sessions').open({ cabinetId: user.cabinet_id, userId: user.id, deviceId: opts.deviceId || null,
    type: opts.type, supportAccessId: opts.supportAccessId, ttlMs: opts.ttlMs }, req);
  const token = jwt.sign({ uid: user.id, cid: user.cabinet_id, sid, role: user.role, email: user.email, nom: user.nom, ini: user.initiales },
    SECRET, { expiresIn: opts.ttlMs ? Math.max(60, Math.round(opts.ttlMs / 1000)) : '12h' });
  res.cookie(COOKIE, token, { ...COOKIE_OPTS, maxAge: opts.ttlMs || MAXAGE });
  return sid;
}

function readUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

/**
 * Vérifie une session CONTRE LA BASE (jamais sur la seule signature du jeton) :
 * utilisateur actif, espace actif, hôte cohérent avec l'espace de la session.
 * @returns {{ ok:true, user } | { ok:false, code, error }}
 */
function checkSession(req) {
  const u = readUser(req);
  if (!u) return { ok: false, code: 'expired', error: 'Non authentifié' };
  // Session serveur (INC 3A) : révoquée, expirée ou inconnue → session terminée (jamais « compte désactivé »).
  const sessions = require('./sessions');
  const sess = sessions.get(u.sid);
  if (!sess || sess.user_id !== u.uid) return { ok: false, code: 'expired_stale', error: 'Votre session a expiré. Reconnectez-vous.' };
  if (!sessions.isActive(sess)) {
    const msg = { espace_suspendu: 'Cet espace de travail est suspendu. Contactez DelaiPay pour le réactiver.',
      espace_supprime: 'Cet espace de travail n’est plus disponible.',
      deconnexion_forcee: 'Votre session a été fermée par un administrateur. Reconnectez-vous.',
      appareil_revoque: 'L’accès depuis cet appareil a été retiré par un administrateur.',
      compte_desactive: 'Votre compte a été désactivé par l’administrateur de votre espace.',
      fin_support: 'L’accès d’assistance DelaiPay est terminé.',
      ...require('./access-policy').MSG }[sess.end_reason];
    return { ok: false, code: 'session_ended', reason: sess.end_reason, error: msg || 'Votre session a expiré. Reconnectez-vous.' };
  }
  let dbUser;
  if (sess.type === 'support') {
    // Session d'assistance DelaiPay : utilisateur SYNTHÉTIQUE en lecture seule, valable tant que l'accès est ouvert.
    const support = require('./support-access');
    const acc = support.get(sess.support_access_id);
    if (!support.isActive(acc) || acc.cabinet_id !== sess.cabinet_id) {
      sessions.end(sess.id, 'fin_support');
      return { ok: false, code: 'session_ended', reason: 'fin_support', error: 'L’accès d’assistance DelaiPay est terminé.' };
    }
    dbUser = support.syntheticUser(acc);
  } else dbUser = db.prepare('SELECT id, cabinet_id, nom, email, role, initiales, titre, actif FROM utilisateur WHERE id=?').get(u.uid);
  // Jeton valide mais utilisateur absent (base de démonstration réinitialisée, compte supprimé) : session expirée,
  // pas « compte désactivé » (NEW-3).
  if (!dbUser) return { ok: false, code: 'expired_stale', error: 'Votre session a expiré. Reconnectez-vous.' };
  if (!dbUser.actif) return { ok: false, code: 'user_inactive', error: 'Votre compte a été désactivé par l’administrateur de votre espace.' };
  // Espace revérifié à CHAQUE requête (rôle, statut et espace relus en base, jamais depuis le jeton) :
  //  - espace désactivé → plus aucun accès, même avec une session encore valide ;
  //  - hôte désignant un AUTRE espace que celui de la session → refus (défense en profondeur).
  const cab = db.prepare('SELECT id, slug, actif, supprime_le, acces_json FROM cabinet WHERE id=?').get(dbUser.cabinet_id);
  if (!cab || cab.actif === 0 || cab.supprime_le) return { ok: false, code: 'workspace_inactive', error: 'Cet espace de travail est désactivé.' };
  const hostSlug = require('./tenant').slugFromHost((req.hostname || (req.headers && req.headers.host)) || '');
  if (hostSlug && String(cab.slug || '').toLowerCase() !== hostSlug)
    return { ok: false, code: 'wrong_workspace', error: 'Cette session appartient à un autre espace de travail.' };
  // Politique d'accès de l'espace (IP autorisées / bloquées, appareil approuvé) revérifiée à CHAQUE requête.
  const deny = require('./access-policy').checkRequest(req, sess, cab);
  if (deny) { sessions.end(sess.id, deny.reason); return { ok: false, code: 'session_ended', reason: deny.reason, error: deny.error }; }
  sessions.touch(sess, req);
  return { ok: true, user: dbUser, session: sess, cabinet: cab };
}

/** Middleware API : exige une session valide, attache req.user + req.cabinetId. */
function requireAuth(req, res, next) {
  const s = checkSession(req);
  if (!s.ok) {
    if (s.code !== 'expired') clearAuthCookie(res);   // session devenue invalide : on la retire (évite toute boucle)
    return res.status(401).json({ error: s.code === 'expired' ? 'Non authentifié' : s.error, code: s.code, ...(s.reason ? { reason: s.reason } : {}) });
  }
  req.user = s.user; req.cabinetId = s.user.cabinet_id; req.session = s.session;
  next();
}

/** Garde de page : redirige vers /login (avec motif) si la session n'est pas valide EN BASE. */
function pageGuard(req, res, next) {
  const s = checkSession(req);
  if (!s.ok) {
    if (s.code !== 'expired' || readUser(req)) clearAuthCookie(res);
    return res.redirect(s.code === 'expired' && !req.cookies[COOKIE] ? '/login' : '/login?reason=' + encodeURIComponent(s.reason || s.code));
  }
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, issueSession, setAuthCookie, clearAuthCookie, requireAuth, pageGuard, readUser, checkSession, COOKIE, DUMMY_HASH };
