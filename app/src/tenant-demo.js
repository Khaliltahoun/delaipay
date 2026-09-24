'use strict';
/**
 * Espaces de DÉMONSTRATION locaux « Premium » et « Client 2 » (données vides, aucun client réel),
 * créés par la même fonction transactionnelle que la commande workspace:create.
 *
 *   DB_PATH=/chemin/base.db DEMO_PASSWORD='…' npm run demo:tenant
 *
 * Refusé en production. Idempotent : un espace existant n'est pas recréé.
 */
if (process.env.NODE_ENV === 'production') { console.error('Refusé : script de démonstration local uniquement.'); process.exit(1); }
const { db } = require('./db');
const workspace = require('./workspace');

const password = process.env.DEMO_PASSWORD;
if (!password) { console.error('Définissez DEMO_PASSWORD (10 caractères minimum, lettres et chiffres).'); process.exit(1); }
const DEMOS = [
  { slug: 'premium', nom: 'Premium Conseil', nomAffiche: 'Premium', raisonLegale: 'Premium Conseil SARL (démo)', primaryColor: '#2F3E6B',
    admin: { email: 'admin@premium.demo', nom: 'Salma Idrissi' } },
  { slug: 'client2', nom: 'Atlas Expertise', nomAffiche: 'Atlas Expertise', raisonLegale: 'Atlas Expertise SARL (démo)', primaryColor: '#6B3A2F',
    admin: { email: 'admin@client2.demo', nom: 'Youssef Benali' } },
];
for (const d of DEMOS) {
  if (db.prepare('SELECT 1 FROM cabinet WHERE lower(slug)=?').get(d.slug)) { console.log(`Espace « ${d.slug} » déjà présent — inchangé.`); continue; }
  try { workspace.createWorkspace({ ...d, admin: { ...d.admin, password } }); console.log(`Espace créé : ${d.slug} → http://${d.slug}.localhost:${process.env.PORT || 3000}/login (${d.admin.email})`); }
  catch (e) { console.error(`Échec ${d.slug} : ${e.message}`); process.exitCode = 1; }
}
