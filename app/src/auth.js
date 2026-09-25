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
  const p = path.join(__dirname, '..', 'data', '.secret');
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

function signToken(user) {
  return jwt.sign(
    { uid: user.id, cid: user.cabinet_id, role: user.role, email: user.email, nom: user.nom, ini: user.initiales },
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
  const dbUser = db.prepare('SELECT id, cabinet_id, nom, email, role, initiales, titre, actif FROM utilisateur WHERE id=?').get(u.uid);
  // Jeton valide mais utilisateur absent (base de démonstration réinitialisée, compte supprimé) : session expirée,
  // pas « compte désactivé » (NEW-3).
  if (!dbUser) return { ok: false, code: 'expired_stale', error: 'Votre session a expiré. Reconnectez-vous.' };
  if (!dbUser.actif) return { ok: false, code: 'user_inactive', error: 'Votre compte a été désactivé par l’administrateur de votre espace.' };
  // Espace revérifié à CHAQUE requête (rôle, statut et espace relus en base, jamais depuis le jeton) :
  //  - espace désactivé → plus aucun accès, même avec une session encore valide ;
  //  - hôte désignant un AUTRE espace que celui de la session → refus (défense en profondeur).
  const cab = db.prepare('SELECT id, slug, actif FROM cabinet WHERE id=?').get(dbUser.cabinet_id);
  if (!cab || cab.actif === 0) return { ok: false, code: 'workspace_inactive', error: 'Cet espace de travail est désactivé.' };
  const hostSlug = require('./tenant').slugFromHost((req.hostname || (req.headers && req.headers.host)) || '');
  if (hostSlug && String(cab.slug || '').toLowerCase() !== hostSlug)
    return { ok: false, code: 'wrong_workspace', error: 'Cette session appartient à un autre espace de travail.' };
  return { ok: true, user: dbUser };
}

/** Middleware API : exige une session valide, attache req.user + req.cabinetId. */
function requireAuth(req, res, next) {
  const s = checkSession(req);
  if (!s.ok) {
    if (s.code !== 'expired') clearAuthCookie(res);   // session devenue invalide : on la retire (évite toute boucle)
    return res.status(401).json({ error: s.code === 'expired' ? 'Non authentifié' : s.error, code: s.code });
  }
  req.user = s.user; req.cabinetId = s.user.cabinet_id;
  next();
}

/** Garde de page : redirige vers /login (avec motif) si la session n'est pas valide EN BASE. */
function pageGuard(req, res, next) {
  const s = checkSession(req);
  if (!s.ok) {
    if (s.code !== 'expired' || readUser(req)) clearAuthCookie(res);
    return res.redirect(s.code === 'expired' && !req.cookies[COOKIE] ? '/login' : '/login?reason=' + encodeURIComponent(s.code));
  }
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, setAuthCookie, clearAuthCookie, requireAuth, pageGuard, readUser, checkSession, COOKIE, DUMMY_HASH };
