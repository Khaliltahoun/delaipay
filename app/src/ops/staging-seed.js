'use strict';
/**
 * Données FICTIVES du staging (3B) — jamais une copie d'une base réelle.
 *
 *   DELAIPAY_ENV=staging DB_PATH=… UPLOADS_DIR=… npm run staging:seed
 *
 * Crée, dans une base VIDE uniquement :
 *   hlz-demo  « Cabinet démo HLZ (fictif) » — dossier fictif STE ORYX AUTO SARL, T1 2026 (référence 36 · 16 · 350 964,42 · 7 025,33)
 *   premium   « Premium Conseil (fictif) » — vide (création d'un premier dossier)
 *   client2   « Atlas Expertise (fictif) » — scénario de vérification (conventions, anomalies, doublon)
 * Mots de passe GÉNÉRÉS, affichés une seule fois (aucun mot de passe de démonstration local réutilisé).
 * Ne crée AUCUN administrateur plateforme : le premier est créé par `npm run platform:admin:create` sur le serveur.
 */
const crypto = require('crypto');

function guard(env = process.env) {
  if (env.DELAIPAY_ENV !== 'staging') throw new Error('Refusé : DELAIPAY_ENV=staging requis (jamais sur la production).');
  if (!env.DB_PATH) throw new Error('Refusé : DB_PATH explicite requis.');
  const domains = String(env.TENANT_BASE_DOMAINS || '');
  if (env.NODE_ENV === 'production' && !domains.split(',').some(d => /(^|\.)staging\./.test(d.trim() + '.')))
    throw new Error('Refusé : TENANT_BASE_DOMAINS ne désigne pas un domaine de staging.');
}
const gen = () => crypto.randomBytes(9).toString('base64url') + '-7a';

async function seed(env = process.env) {
  guard(env);
  const { db } = require('../db');
  if (db.prepare('SELECT COUNT(*) n FROM cabinet').get().n > 0) throw new Error('Refusé : la base n’est pas vide (le seed du staging ne s’applique qu’à une base neuve).');
  const accounts = [];
  // 1. Espace de référence fictif (même fonction que le premier démarrage local), renommé pour ne jamais évoquer le vrai cabinet.
  const hlzPw = gen();
  const prevPw = process.env.ADMIN_PASSWORD; process.env.ADMIN_PASSWORD = hlzPw;
  try { await require('../seed').ensureSeed(); } finally { if (prevPw === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prevPw; }
  db.prepare(`UPDATE cabinet SET slug='hlz-demo', nom='Cabinet démo HLZ (fictif)', nom_affiche='Cabinet démo HLZ' WHERE lower(slug)='hlz'`).run();
  const hlzAdmin = db.prepare(`SELECT u.email FROM utilisateur u JOIN cabinet c ON c.id=u.cabinet_id WHERE c.slug='hlz-demo'`).get();
  accounts.push({ espace: 'hlz-demo', email: hlzAdmin.email, role: 'admin', password: hlzPw });
  // 2. Premium et Client 2 (fonction transactionnelle de création d'espace).
  const ws = require('../workspace');
  for (const d of [
    { slug: 'premium', nom: 'Premium Conseil (fictif)', nomAffiche: 'Premium', raisonLegale: 'Premium Conseil SARL (fictif)', primaryColor: '#2F3E6B', adresse: '12 bd Zerktouni, 20000 Casablanca', admin: { email: 'admin@premium.demo', nom: 'Salma Idrissi' } },
    { slug: 'client2', nom: 'Atlas Expertise (fictif)', nomAffiche: 'Atlas Expertise', raisonLegale: 'Atlas Expertise SARL (fictif)', primaryColor: '#6B3A2F', adresse: '45 rue Ibn Batouta, 90000 Tanger', admin: { email: 'admin@client2.demo', nom: 'Youssef Benali' } },
  ]) {
    const pw = gen();
    ws.createWorkspace({ ...d, admin: { ...d.admin, password: pw } });
    accounts.push({ espace: d.slug, email: d.admin.email, role: 'admin', password: pw });
  }
  const c2pw = gen();
  const r = require('../demo-reset').prepareVerificationScenario({ slug: 'client2', env: { DEMO_PASSWORD: c2pw } });
  for (const email of r.users) accounts.push({ espace: 'client2', email, role: email.startsWith('comptable') ? 'comptable' : 'lecture', password: c2pw });
  require('../platform/store'); // schéma plateforme présent (aucun administrateur créé ici)
  return { accounts, factures: { 'hlz-demo': db.prepare(`SELECT COUNT(*) n FROM facture f JOIN cabinet c ON c.id=f.cabinet_id WHERE c.slug='hlz-demo'`).get().n, client2: r.factures },
    platformAdmins: db.prepare('SELECT COUNT(*) n FROM platform_admin').get().n };
}
module.exports = { seed, guard };
if (require.main === module) {
  seed().then(r => {
    console.log('Staging : données FICTIVES créées. Mots de passe affichés UNE seule fois — à conserver dans votre gestionnaire de mots de passe :');
    for (const a of r.accounts) console.log(`  ${a.espace.padEnd(9)} ${a.role.padEnd(9)} ${a.email.padEnd(24)} ${a.password}`);
    console.log(`Factures : hlz-demo ${r.factures['hlz-demo']}, client2 ${r.factures.client2}. Administrateurs plateforme : ${r.platformAdmins} (créez le premier avec npm run platform:admin:create).`);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
