'use strict';
/**
 * Création d'un espace de travail + premier administrateur (transaction unique).
 *
 *   DB_PATH=… npm run workspace:create -- --slug premium --nom "Premium Conseil" \
 *     --admin-email admin@premium.ma --admin-nom "Salma Idrissi" [--couleur #2F3E6B] [--raison "Premium Conseil SARL"]
 *
 *   npm run workspace:create -- --slug premium --desactiver   (ou --activer)
 *
 * Mot de passe : variable WORKSPACE_ADMIN_PASSWORD, sinon généré et affiché UNE fois (jamais journalisé ailleurs).
 * Outil interne local : refusé en production tant que le provisionnement multi-espaces n'est pas ouvert.
 */
if (process.env.NODE_ENV === 'production') { console.error('Refusé : création d’espace réservée à l’environnement local pour le moment.'); process.exit(1); }
const crypto = require('crypto');
const workspace = require('./workspace');

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';

// Statut d'un espace existant : --slug X --desactiver | --activer (suspension commerciale, réversible).
if (args.desactiver || args.activer) {
  const { db } = require('./db');
  const cab = db.prepare('SELECT id, slug FROM cabinet WHERE lower(slug)=?').get(String(args.slug || '').toLowerCase());
  if (!cab) { console.error('Espace introuvable : ' + args.slug); process.exit(1); }
  workspace.setWorkspaceActive(cab.id, !!args.activer);
  console.log(`Espace « ${cab.slug} » ${args.activer ? 'réactivé' : 'désactivé'}.`);
  process.exit(0);
}
const generated = !process.env.WORKSPACE_ADMIN_PASSWORD;
const password = process.env.WORKSPACE_ADMIN_PASSWORD || (crypto.randomBytes(9).toString('base64url') + '7a');
try {
  const r = workspace.createWorkspace({
    slug: args.slug, nom: args.nom, raisonLegale: args.raison, nomAffiche: args.affiche, primaryColor: args.couleur,
    contactEmail: args.contact, adresse: args.adresse,
    admin: { email: args['admin-email'], nom: args['admin-nom'], password },
  });
  console.log(`Espace créé : ${r.slug}`);
  console.log(`  Connexion : http://${r.slug}.localhost:${process.env.PORT || 3000}/login`);
  console.log(`  Administrateur : ${String(args['admin-email']).toLowerCase()}`);
  if (generated) console.log(`  Mot de passe initial (affiché une seule fois) : ${password}`);
} catch (e) { console.error('Création refusée : ' + e.message); process.exit(1); }
