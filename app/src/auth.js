'use strict';
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

// Secret : variable d'env en prod, sinon persistée localement.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const p = path.join(__dirname, '..', 'data', '.secret');
  try { return fs.readFileSync(p, 'utf8'); }
  catch (_) {
    const s = require('crypto').randomBytes(48).toString('hex');
    try { fs.writeFileSync(p, s, { mode: 0o600 }); } catch (_) {}
    return s;
  }
}
const SECRET = loadSecret();
const COOKIE = 'dp_token';
const MAXAGE = 1000 * 60 * 60 * 12; // 12 h

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function verifyPassword(pw, hash) { try { return bcrypt.compareSync(pw, hash); } catch { return false; } }

function signToken(user) {
  return jwt.sign(
    { uid: user.id, cid: user.cabinet_id, role: user.role, email: user.email, nom: user.nom, ini: user.initiales },
    SECRET, { expiresIn: '12h' });
}
function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', maxAge: MAXAGE,
    secure: process.env.NODE_ENV === 'production',
  });
}
function clearAuthCookie(res) { res.clearCookie(COOKIE); }

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

module.exports = { hashPassword, verifyPassword, signToken, setAuthCookie, clearAuthCookie, requireAuth, pageGuard, readUser, COOKIE };
