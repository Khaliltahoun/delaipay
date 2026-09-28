'use strict';
const { createApp, VERSION } = require('./app');
const { ensureSeed } = require('./seed');

const PORT = process.env.PORT || 3000;
const app = createApp();

// DELAIPAY_AUTO_SEED=0 (staging) : aucun compte ni client créé automatiquement au premier démarrage —
// les données fictives du staging viennent de `npm run staging:seed`, le 1er administrateur plateforme de la CLI.
const seed = process.env.DELAIPAY_AUTO_SEED === '0' ? Promise.resolve({ seeded: false }) : ensureSeed();
seed.then((info) => {
  // HOST=127.0.0.1 en déploiement : l'application n'écoute que localement, nginx est le seul point d'entrée public.
  app.listen(PORT, process.env.HOST || undefined, () => {
    console.log('\n  ╭─────────────────────────────────────────────╮');
    console.log('  │   DelaiPay — SaaS délais de paiement 69-21   │');
    console.log('  ╰─────────────────────────────────────────────╯');
    console.log(`  ▸ URL      : http://localhost:${PORT}`);
    console.log(`  ▸ Console  : http://${require('./tenant').consoleHosts()[0] || 'admin.localhost'}:${PORT}`);
    console.log(`  ▸ Version  : ${VERSION}`);
    if (info && info.seeded) {
      console.log(`  ▸ Compte initial créé : ${info.email}`);
      // Mot de passe défini via ADMIN_PASSWORD : jamais journalisé. Généré (démo locale) : affiché cette seule fois.
      if (info.password) console.log(`  ▸ Mot de passe généré (affiché une seule fois) : ${info.password}`);
    }
    console.log('');
  });
}).catch(err => { console.error('Échec du démarrage :', err); process.exit(1); });
