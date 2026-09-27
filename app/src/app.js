'use strict';
/**
 * Construction de l'application HTTP (sans écoute) — utilisée par server.js et par les tests.
 *
 * Répartition par NOM D'HÔTE, avant toute autre route :
 *   admin.<domaine>  → console plateforme (src/platform/router.js) — AUCUNE route d'espace n'y est servie ;
 *   autre hôte       → application des espaces (pages, /api) — AUCUNE route de console n'y est servie.
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pageGuard, readUser, checkSession, clearAuthCookie } = require('./auth');
const { securityHeaders } = require('./security');
const tenant = require('./tenant');
const netu = require('./net');
const runtime = require('./runtime');

const PUB = path.join(__dirname, '..', 'public');

/* ============================================================ gestion du cache
 * Version de build = empreinte du contenu des assets. Injectée en ?v=… dans le
 * HTML pour un cache-busting fiable après chaque déploiement.
 */
function buildVersion() {
  const h = crypto.createHash('sha1');
  const rels = ['../src/brand-color.js', '../src/time-format.js'];
  for (const dir of ['js', 'css']) { try { for (const f of fs.readdirSync(path.join(PUB, dir)).sort()) rels.push(`${dir}/${f}`); } catch (_) {} }
  for (const rel of rels) { try { h.update(fs.readFileSync(path.join(PUB, rel))); } catch (_) {} }
  return h.digest('hex').slice(0, 10);
}
const VERSION = process.env.APP_VERSION || buildVersion();

// HTML rendu une fois au démarrage : liens d'assets versionnés + non mis en cache.
function renderPage(file) {
  let html = fs.readFileSync(path.join(PUB, file), 'utf8');
  html = html.replace(/(\/(?:css|js|assets)\/[\w./-]+?\.(?:css|js))"/g, `$1?v=${VERSION}"`);
  return html;
}
const PAGES = {};
for (const [k, f] of Object.entries({ app: 'app.html', login: 'login.html', invite: 'invite.html', reset: 'reset.html', support: 'support.html', console: 'console.html' })) {
  try { PAGES[k] = renderPage(f); } catch (_) {}
}
function sendPage(res, name) {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.type('html').send(PAGES[name]);
}

// Assets statiques : immuables 1 an si versionnés (?v=…), sinon revalidation courte.
function assetCache(req, res, next) {
  if (req.query.v) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  else res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
  next();
}
const staticOpts = { cacheControl: false, etag: true, lastModified: true, index: false };
/** Ressources publiques communes aux espaces et à la console (police, CSS, icônes). */
function mountStatic(app) {
  app.use('/assets', assetCache, express.static(path.join(PUB, 'assets'), staticOpts));
  app.use('/css', assetCache, express.static(path.join(PUB, 'css'), staticOpts));
  app.get('/js/brand-color.js', assetCache, (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'brand-color.js')));
  app.get('/js/time-format.js', assetCache, (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'time-format.js')));
  app.use('/js', assetCache, express.static(path.join(PUB, 'js'), staticOpts));
  // Icône de l'onglet (les navigateurs la demandent à la racine même avec <link rel="icon">).
  app.get('/favicon.ico', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('image/x-icon').sendFile(path.join(PUB, 'assets', 'brand', 'favicon.ico'));
  });
}

function createApp() {
  const app = express();
  // Proxy de confiance : X-Forwarded-For n'est cru QUE depuis les proxys déclarés (TRUST_PROXY) — src/net.js.
  app.set('trust proxy', netu.trustProxySetting());
  app.disable('x-powered-by');
  app.disable('etag'); // ETag géré par express.static pour les assets ; désactivé sinon

  // Console plateforme : sous-application isolée, choisie par l'hôte AVANT toute route d'espace.
  const consoleApp = require('./platform/router').createConsoleApp({ mountStatic, sendPage, version: VERSION });
  app.use((req, res, next) => (tenant.isConsoleHost(req.hostname || req.headers.host) ? consoleApp(req, res, next) : next()));

  app.use(securityHeaders);
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  mountStatic(app);

  // Manifeste d'application web (icônes d'écran d'accueil ; aucune ressource distante).
  app.get('/manifest.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('application/manifest+json').sendFile(path.join(PUB, 'manifest.webmanifest'));
  });

  // Pages
  // Indices clients (Sec-CH-UA-Model…) : demandés sur les pages, pour enregistrer le modèle d'appareil SANS le deviner.
  const ACCEPT_CH = require('./useragent').ACCEPT_CH;
  const CH_PAGES = new Set(['/login', '/', '/app', '/invite', '/reset']);
  app.use((req, res, next) => { if (req.method === 'GET' && CH_PAGES.has(req.path)) res.setHeader('Accept-CH', ACCEPT_CH); next(); });
  app.get('/login', (req, res) => {
    // Redirection vers l'application UNIQUEMENT si la session est valide en base (sinon boucle login ↔ app).
    const s = checkSession(req);
    if (s.ok) return res.redirect('/');
    if (readUser(req)) clearAuthCookie(res);
    sendPage(res, 'login');
  });
  // Acceptation d'invitation (publique : le jeton fait foi, vérifié côté API).
  app.get('/invite', (req, res) => { res.setHeader('Referrer-Policy', 'no-referrer'); sendPage(res, 'invite'); });
  // Réinitialisation de mot de passe (publique : le jeton, dans le fragment d'URL, fait foi).
  app.get('/reset', (req, res) => { res.setHeader('Referrer-Policy', 'no-referrer'); sendPage(res, 'reset'); });
  // Ouverture d'un accès d'assistance DelaiPay (jeton à usage unique dans le fragment d'URL).
  app.get('/support', (req, res) => { res.setHeader('Referrer-Policy', 'no-referrer'); sendPage(res, 'support'); });
  app.get(['/', '/app'], pageGuard, (req, res) => sendPage(res, 'app'));

  // API
  app.use('/api', require('./api'));

  // Health
  app.get('/healthz', (req, res) => res.json({ ok: true, version: VERSION, ts: Date.now() }));

  // 404
  app.use((req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Cette action n’est pas disponible. Actualisez la page : l’application a peut-être été mise à jour.', code: 'route_inconnue' });
    res.redirect('/');
  });

  // Filet de sécurité : ne jamais divulguer de trace au client.
  app.use((err, req, res, next) => {
    runtime.countError();
    console.error('Erreur non gérée :', err);
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api')) return res.status(500).json({ error: 'L’opération n’a pas abouti à cause d’une erreur inattendue. Réessayez ; si le problème persiste, contactez votre administrateur.', code: 'erreur_serveur' });
    res.status(500).send('Une erreur inattendue est survenue. Réessayez dans un instant.');
  });
  return app;
}

module.exports = { createApp, VERSION };
