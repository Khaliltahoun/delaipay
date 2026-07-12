'use strict';
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { pageGuard, readUser } = require('./auth');
const api = require('./api');
const { ensureSeed } = require('./seed');

const app = express();
const PUB = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Assets statiques (css/js/img)
app.use('/assets', express.static(path.join(PUB, 'assets')));
app.use('/css', express.static(path.join(PUB, 'css')));
app.use('/js', express.static(path.join(PUB, 'js')));

// Pages
app.get('/login', (req, res) => {
  if (readUser(req)) return res.redirect('/');
  res.sendFile(path.join(PUB, 'login.html'));
});
app.get(['/', '/app'], pageGuard, (req, res) => res.sendFile(path.join(PUB, 'app.html')));

// API
app.use('/api', api);

// Health
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Route inconnue' });
  res.redirect('/');
});

ensureSeed().then((info) => {
  app.listen(PORT, () => {
    console.log('\n  ╭─────────────────────────────────────────────╮');
    console.log('  │   DelaiPay — SaaS délais de paiement 69-21   │');
    console.log('  ╰─────────────────────────────────────────────╯');
    console.log(`  ▸ URL      : http://localhost:${PORT}`);
    if (info && info.seeded) {
      console.log(`  ▸ Login    : ${info.email}`);
      console.log(`  ▸ Password : ${info.password}`);
    }
    console.log('');
  });
}).catch(err => { console.error('Échec du démarrage :', err); process.exit(1); });
