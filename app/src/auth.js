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

/** Middleware API : exige une session valide, attache req.user + req.cabinetId. */
function requireAuth(req, res, next) {
  const u = readUser(req);
  if (!u) return res.status(401).json({ error: 'Non authentifié' });
  const dbUser = db.prepare('SELECT id, cabinet_id, nom, email, role, initiales, titre, actif FROM utilisateur WHERE id=?').get(u.uid);
  if (!dbUser || !dbUser.actif) return res.status(401).json({ error: 'Session invalide' });
  req.user = dbUser; req.cabinetId = dbUser.cabinet_id;
  next();
}

/** Garde de page : redirige vers /login si non authentifié. */
function pageGuard(req, res, next) {
  if (!readUser(req)) return res.redirect('/login');
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, setAuthCookie, clearAuthCookie, requireAuth, pageGuard, readUser, COOKIE, DUMMY_HASH };
