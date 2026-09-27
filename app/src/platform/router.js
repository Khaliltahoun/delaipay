'use strict';
/**
 * Console plateforme — sous-application servie UNIQUEMENT sur l'hôte réservé (admin.localhost / admin.delaipay.com).
 *
 * Défenses propres à la console (en plus de celles des espaces) :
 *  - liste d'IP autorisées facultative (PLATFORM_ALLOWED_IPS et/ou CLI) : hors liste → 403 générique, avant tout ;
 *  - CSP stricte (aucun script inline), noindex, aucune mise en cache des réponses d'API ;
 *  - toute écriture exige l'en-tête X-DP-Console: 1 (anti-CSRF, en plus de SameSite=Strict) et une origine identique ;
 *  - limitation de débit stricte et messages d'erreur génériques (aucune indication sur l'existence d'un compte).
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const pauth = require('./auth');
const store = require('./store');
const { rateLimit } = require('../security');
const netu = require('../net');

const CONSOLE_CSP = [
  "default-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "object-src 'none'",
  "img-src 'self' data:", "font-src 'self'", "style-src 'self' 'unsafe-inline'", "script-src 'self'",
  "connect-src 'self'", "form-action 'self'",
].join('; ');

function consoleHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONSOLE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** Liste d'IP autorisées de la console : variable d'environnement + liste gérée par la CLI. Vide = pas de filtre. */
function consoleAllowlist() {
  const env = String(process.env.PLATFORM_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const cli = (store.getSetting('console_allowlist', []) || []).map(e => e.cidr);
  return [...env, ...cli];
}
function ipGate(req, res, next) {
  const list = consoleAllowlist();
  if (!list.length || netu.ipInList(netu.clientIp(req), list)) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Accès refusé.', code: 'forbidden' });
  res.status(403).type('text/plain; charset=utf-8').send('Accès refusé.');
}

function csrfGate(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-DP-Console') !== '1') return res.status(403).json({ error: 'Requête refusée.', code: 'csrf' });
  const origin = req.get('Origin');
  if (origin) {
    let host = null; try { host = new URL(origin).host.toLowerCase(); } catch (_) {}
    if (host !== String(req.headers.host || '').toLowerCase()) return res.status(403).json({ error: 'Requête refusée.', code: 'csrf' });
  }
  next();
}

function createConsoleApp({ mountStatic, sendPage, version }) {
  const app = express.Router();
  app.use(consoleHeaders);
  app.use(ipGate);
  app.use(cookieParser());
  mountStatic(app);

  const api = express.Router();
  api.use(express.json({ limit: '200kb' }));
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(csrfGate);

  // Débit : 5 essais de mot de passe / 15 min par (IP, e-mail) ; 20 / 15 min par IP ; 10 codes / 15 min par IP.
  const loginIp = rateLimit({ windowMs: 15 * 60e3, max: 20, message: 'Trop de tentatives. Réessayez plus tard.', code: 'rate_limited', keyGenerator: r => 'ip|' + netu.clientIp(r) });
  const loginId = rateLimit({ windowMs: 15 * 60e3, max: 5, message: 'Trop de tentatives. Réessayez plus tard.', code: 'rate_limited',
    keyGenerator: r => netu.clientIp(r) + '|' + String((r.body && r.body.email) || '').toLowerCase().trim(),
    onLimit: r => store.paudit({ id: null, email: String((r.body && r.body.email) || '').toLowerCase().trim().slice(0, 254) }, 'verrouillage_console', { details: { motif: '5 échecs en 15 min' } }, r) });
  const codeLimit = rateLimit({ windowMs: 15 * 60e3, max: 10, message: 'Trop de tentatives. Réessayez plus tard.', code: 'rate_limited', keyGenerator: r => 'code|' + netu.clientIp(r) });

  const fail = res => res.status(401).json({ error: pauth.GENERIC, code: 'identifiants' });

  api.post('/auth/login', loginIp, loginId, (req, res) => {
    const b = req.body || {};
    const r = pauth.passwordStep(b.email, b.password, req);
    if (!r.ok) return fail(res);
    loginId.reset(req);
    pauth.setCookie(res, r.session.token);
    res.json({ ok: true, next: r.next });
  });
  // Étape courante (l'interface s'en sert pour afficher le bon écran) — ne révèle rien sans cookie valide.
  api.get('/auth/state', (req, res) => {
    const r = pauth.readSession(req, { touch: false });
    res.json({ etape: r.session ? r.session.etape : null, idleSeconds: pauth.IDLE_MIN * 60 });
  });
  const stage = name => (req, res, next) => {
    const r = pauth.readSession(req, { touch: false });
    if (!r.session || r.session.etape !== name) return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.', code: 'etape_invalide' });
    req.psession = r.session; req.padmin = r.admin; next();
  };
  api.get('/auth/enrolment', stage('enrolement'), (req, res) => {
    const d = pauth.enrolmentData(req.psession, req.padmin);
    res.json({ email: req.padmin.email, secret: d.secretGroups, uri: d.uri, qrSvg: d.qrSvg });
  });
  api.post('/auth/enrolment', codeLimit, stage('enrolement'), (req, res) => {
    const r = pauth.confirmEnrolment(req.psession, req.padmin, (req.body || {}).code, req, res);
    if (!r.ok) return res.status(401).json({ error: 'Code incorrect ou expiré.', code: 'code_incorrect' });
    res.json({ ok: true, recoveryCodes: r.recoveryCodes });
  });
  api.post('/auth/code', codeLimit, stage('mfa'), (req, res) => {
    const b = req.body || {};
    const r = pauth.codeStep(req.psession, req.padmin, { code: b.code, recoveryCode: b.recoveryCode }, req, res);
    if (!r.ok) return res.status(401).json({ error: 'Code incorrect ou expiré.', code: 'code_incorrect' });
    res.json({ ok: true, method: r.method, recoveryCodesRemaining: r.remaining });
  });
  api.post('/auth/logout', (req, res) => {
    const r = pauth.readSession(req, { touch: false });
    if (r.session) { pauth.endSession(r.session.id, 'deconnexion'); store.paudit(r.admin, 'deconnexion_console', { type: 'platform_admin', id: r.admin.id, libelle: r.admin.email }, req); }
    pauth.clearCookie(res);
    res.json({ ok: true });
  });

  // ---- tout ce qui suit exige une session complète (mot de passe + 2FA)
  api.use(pauth.requireConsole);
  api.get('/me', (req, res) => {
    res.json({ admin: pauth.publicAdmin(req.padmin), session: { expiresAt: req.psession.expires_at, idleSeconds: pauth.IDLE_MIN * 60 },
      recoveryCodesRemaining: pauth.remainingRecoveryCodes(req.padmin.id), ip: netu.clientIp(req),
      // Fuseau d'affichage de la console (horodatages stockés en UTC) : PLATFORM_TIMEZONE, défaut Africa/Casablanca.
      fuseau: process.env.PLATFORM_TIMEZONE || 'Africa/Casablanca' });
  });
  api.post('/me/recovery-codes', codeLimit, (req, res) => {
    const code = (req.body || {}).code;
    const totp = require('./totp');
    const step = totp.verify(store.open(req.padmin.totp_secret_enc), code, { lastStep: req.padmin.totp_last_step });
    if (step == null) return res.status(401).json({ error: 'Code incorrect ou expiré.', code: 'code_incorrect' });
    store.db.prepare('UPDATE platform_admin SET totp_last_step=? WHERE id=?').run(step, req.padmin.id);
    const codes = pauth.regenerateRecoveryCodes(req.padmin.id);
    store.paudit(req.padmin, 'codes_de_secours_regeneres', { type: 'platform_admin', id: req.padmin.id, libelle: req.padmin.email }, req);
    res.json({ ok: true, recoveryCodes: codes });
  });
  api.get('/audit', (req, res) => {
    const q = req.query;
    res.json({ rows: store.listAudit({ limit: q.limit, before: q.before || null, cibleType: q.type || null, cibleId: q.cible || null, action: q.action || null }) });
  });

  api.get('/console-allowlist', (req, res) => {
    const env = String(process.env.PLATFORM_ALLOWED_IPS || '').split(',').map(x => x.trim()).filter(Boolean).map(cidr => ({ cidr, label: null, source: 'variable PLATFORM_ALLOWED_IPS' }));
    const cli = (store.getSetting('console_allowlist', []) || []).map(e => ({ cidr: e.cidr, label: e.label, source: 'ligne de commande' }));
    res.json({ rows: [...env, ...cli], ip: netu.clientIp(req) });
  });
  for (const mod of require('./routes')) mod(api, { version });

  api.use((req, res) => res.status(404).json({ error: 'Action inconnue.', code: 'route_inconnue' }));
  api.use((err, req, res, next) => {
    require('../runtime').countError();
    console.error('Erreur console :', err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'L’opération n’a pas abouti. Réessayez.', code: err.code || 'erreur_serveur' });
  });

  app.use('/api/platform', api);
  app.get('/', (req, res) => sendPage(res, 'console'));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  // Toute autre adresse de l'hôte console : 404 (jamais une page ou une API d'espace).
  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Action inconnue.', code: 'route_inconnue' });
    res.status(404).type('text/plain; charset=utf-8').send('Page introuvable.');
  });
  return app;
}

module.exports = { createConsoleApp, consoleAllowlist };
