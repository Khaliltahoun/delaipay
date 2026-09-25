'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pageGuard, readUser, checkSession, clearAuthCookie } = require('./auth');
const api = require('./api');
const { ensureSeed } = require('./seed');
const { securityHeaders } = require('./security');

const app = express();
const PUB = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

// Derrière le reverse-proxy nginx : req.ip = IP réelle du client (audit + rate-limit).
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.disable('etag'); // ETag géré par express.static pour les assets ; désactivé sinon

app.use(securityHeaders);
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

/* ============================================================ gestion du cache
 * Version de build = empreinte du contenu des assets. Injectée en ?v=… dans le
 * HTML pour un cache-busting fiable après chaque déploiement.
 */
function buildVersion() {
  const h = crypto.createHash('sha1');
  for (const rel of ['js/app.js', 'js/login.js', 'js/invite.js', 'css/app.css']) {
    try { h.update(fs.readFileSync(path.join(PUB, rel))); } catch (_) {}
  }
  return h.digest('hex').slice(0, 10);
}
const VERSION = process.env.APP_VERSION || buildVersion();

// HTML rendu une fois au démarrage : liens d'assets versionnés + non mis en cache.
function renderPage(file) {
  let html = fs.readFileSync(path.join(PUB, file), 'utf8');
  html = html.replace(/(\/(?:css|js|assets)\/[\w./-]+?\.(?:css|js))"/g, `$1?v=${VERSION}"`);
  return html;
}
const PAGES = { app: renderPage('app.html'), login: renderPage('login.html'), invite: renderPage('invite.html') };
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
app.use('/assets', assetCache, express.static(path.join(PUB, 'assets'), staticOpts));
app.use('/css', assetCache, express.static(path.join(PUB, 'css'), staticOpts));
app.use('/js', assetCache, express.static(path.join(PUB, 'js'), staticOpts));

// Icône de l'onglet (les navigateurs la demandent à la racine même avec <link rel="icon">).
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('image/x-icon').sendFile(path.join(PUB, 'assets', 'brand', 'favicon.ico'));
});
// Manifeste d'application web (icônes d'écran d'accueil ; aucune ressource distante).
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('application/manifest+json').sendFile(path.join(PUB, 'manifest.webmanifest'));
});

// Pages
app.get('/login', (req, res) => {
  // Redirection vers l'application UNIQUEMENT si la session est valide en base (sinon boucle login ↔ app).
  const s = checkSession(req);
  if (s.ok) return res.redirect('/');
  if (readUser(req)) clearAuthCookie(res);
  sendPage(res, 'login');
});
// Acceptation d'invitation (publique : le jeton fait foi, vérifié côté API).
app.get('/invite', (req, res) => { res.setHeader('Referrer-Policy', 'no-referrer'); sendPage(res, 'invite'); });
app.get(['/', '/app'], pageGuard, (req, res) => sendPage(res, 'app'));

// API
app.use('/api', api);

// Health
app.get('/healthz', (req, res) => res.json({ ok: true, version: VERSION, ts: Date.now() }));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Route inconnue' });
  res.redirect('/');
});

// Filet de sécurité : ne jamais divulguer de trace au client.
app.use((err, req, res, next) => {
  console.error('Erreur non gérée :', err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Erreur serveur' });
  res.status(500).send('Erreur serveur');
});

ensureSeed().then((info) => {
  app.listen(PORT, () => {
    console.log('\n  ╭─────────────────────────────────────────────╮');
    console.log('  │   DelaiPay — SaaS délais de paiement 69-21   │');
    console.log('  ╰─────────────────────────────────────────────╯');
    console.log(`  ▸ URL      : http://localhost:${PORT}`);
    console.log(`  ▸ Version  : ${VERSION}`);
    if (info && info.seeded) {
      console.log(`  ▸ Compte initial créé : ${info.email}`);
      // Mot de passe défini via ADMIN_PASSWORD : jamais journalisé. Généré (démo locale) : affiché cette seule fois.
      if (info.password) console.log(`  ▸ Mot de passe généré (affiché une seule fois) : ${info.password}`);
    }
    console.log('');
  });
}).catch(err => { console.error('Échec du démarrage :', err); process.exit(1); });
