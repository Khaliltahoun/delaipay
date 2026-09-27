'use strict';
const { createApp, VERSION } = require('./app');
const { ensureSeed } = require('./seed');

const PORT = process.env.PORT || 3000;
const app = createApp();

ensureSeed().then((info) => {
  app.listen(PORT, () => {
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
