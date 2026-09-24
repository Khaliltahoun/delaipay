'use strict';
/**
 * Crée un espace de démonstration LOCAL « Premium » (slug `premium`) pour tester l'architecture
 * sous-domaine → espace : http://premium.localhost:<port>. Aucun client, aucune donnée métier.
 *
 *   DB_PATH=/chemin/base.db DEMO_PASSWORD='…' npm run demo:tenant
 *
 * Refusé en production. Idempotent : ne recrée pas un espace existant.
 */
const { db } = require('./db');
const { hashPassword } = require('./auth');
const { uid } = require('./util');

if (process.env.NODE_ENV === 'production') { console.error('Refusé : script de démonstration local uniquement.'); process.exit(1); }

const slug = (process.env.DEMO_SLUG || 'premium').toLowerCase();
const exists = db.prepare('SELECT id FROM cabinet WHERE lower(slug)=?').get(slug);
if (exists) { console.log(`Espace « ${slug} » déjà présent — rien à faire.`); process.exit(0); }

const password = process.env.DEMO_PASSWORD || require('crypto').randomBytes(9).toString('base64url');
const email = (process.env.DEMO_EMAIL || `admin@${slug}.demo`).toLowerCase();
const cab = uid('cab');
db.prepare(`INSERT INTO cabinet (id, nom, slug, plan, nom_affiche, couleur_primaire, couleur_accent)
            VALUES (?,?,?,?,?,?,?)`).run(cab, 'Premium (démo)', slug, 'demo', 'Premium', '#2F3E6B', '#B08D57');
db.prepare(`INSERT INTO utilisateur (id, cabinet_id, nom, email, password_hash, role, initiales, titre)
            VALUES (?,?,?,?,?,?,?,?)`).run(uid('usr'), cab, 'Administrateur démo', email, hashPassword(password), 'admin', 'AD', 'Administrateur');
console.log(`Espace de démonstration créé : ${slug}`);
console.log(`  URL locale : http://${slug}.localhost:${process.env.PORT || 3000}/login`);
console.log(`  Compte     : ${email}`);
if (!process.env.DEMO_PASSWORD) console.log(`  Mot de passe (généré, affiché une seule fois) : ${password}`);
