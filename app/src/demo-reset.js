'use strict';
/**
 * Remise à blanc d'un espace de DÉMONSTRATION (retester l'onboarding depuis zéro, sans aide terminal).
 *
 *   DB_PATH=/chemin/base-demo.db npm run demo:reset -- --slug client2 --confirm client2
 *
 * Garde-fous (tous obligatoires) :
 *  - jamais en production ; DB_PATH explicite ; jamais la base par défaut (data/delaipay.db) ;
 *  - l'espace ciblé n'est pas l'espace canonique (`hlz`) et ne contient pas le client de référence ;
 *  - tous ses comptes utilisent une adresse fictive « …@….demo » (espace créé par npm run demo:tenant) ;
 *  - confirmation explicite `--confirm <slug>` ;
 *  - sauvegarde complète de la base (VACUUM INTO) avant toute écriture, dans data/backups/.
 * Effet : données métier, fichiers, invitations, identité (raison sociale, logo, contact) et progression d'onboarding
 * de CET espace supprimés ; les comptes utilisateurs sont conservés (même connexion) ; audit « reinitialisation_demo ».
 */
const fs = require('fs');
const path = require('path');

const CANONICAL_SLUGS = new Set(['hlz']);
const DEMO_EMAIL_RE = /@[a-z0-9.-]+\.demo$/i;
// Enfants avant parents (les clés étrangères sont en plus différées jusqu'à la validation).
const TABLES_BY_DECLARATION = ['ligne_declaration', 'visa'];
const TABLES_BY_CABINET = ['import_ligne', 'anomalie', 'periode_declaration', 'declaration', 'facture', 'convention', 'document',
  'import_lot', 'fournisseur', 'modele_mapping', 'entreprise', 'invitation'];

class DemoResetError extends Error {}

function defaultDbPath() { return path.join(__dirname, '..', 'data', 'delaipay.db'); }

/** Vérifie les garde-fous puis remet l'espace à blanc. @returns {{ slug, backup, counts, files }} */
function resetDemoWorkspace({ slug, confirm, env = process.env, now = new Date() } = {}) {
  if (env.NODE_ENV === 'production') throw new DemoResetError('Refusé : la remise à blanc est réservée aux bases de démonstration locales.');
  if (!env.DB_PATH) throw new DemoResetError('Refusé : indiquez explicitement la base de démonstration (DB_PATH=…).');
  if (path.resolve(env.DB_PATH) === path.resolve(defaultDbPath())) throw new DemoResetError('Refusé : data/delaipay.db est la base par défaut, pas une base de démonstration.');
  slug = String(slug || '').trim().toLowerCase();
  if (!slug) throw new DemoResetError('Indiquez l’espace à remettre à blanc : --slug <identifiant>.');
  if (confirm !== slug) throw new DemoResetError(`Confirmation requise : ajoutez --confirm ${slug}.`);
  if (CANONICAL_SLUGS.has(slug)) throw new DemoResetError(`Refusé : « ${slug} » porte les données de référence (non-régression) et ne peut pas être remis à blanc.`);

  const { db, audit } = require('./db');
  const cab = db.prepare('SELECT * FROM cabinet WHERE lower(slug)=?').get(slug);
  if (!cab) throw new DemoResetError(`Aucun espace « ${slug} » dans cette base.`);
  const { DEMO_CLIENT } = require('./demo-fixture');
  if (db.prepare('SELECT 1 FROM entreprise WHERE cabinet_id=? AND raison_sociale=?').get(cab.id, DEMO_CLIENT.raison_sociale))
    throw new DemoResetError(`Refusé : l’espace « ${slug} » contient le client de référence ${DEMO_CLIENT.raison_sociale}.`);
  const users = db.prepare('SELECT email FROM utilisateur WHERE cabinet_id=?').all(cab.id);
  const real = users.filter(u => !DEMO_EMAIL_RE.test(u.email || ''));
  if (!users.length || real.length) throw new DemoResetError(`Refusé : l’espace « ${slug} » a des comptes non fictifs (${real.map(u => u.email).join(', ') || 'aucun compte'}) — ce n’est pas un espace de démonstration.`);

  // Sauvegarde complète avant toute écriture.
  const dir = path.join(path.dirname(path.resolve(env.DB_PATH)), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const backup = path.join(dir, `${path.basename(env.DB_PATH, '.db')}.avant-reset-${slug}-${stamp}.db`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);

  // Fichiers à retirer après validation (documents importés, justificatifs, logo).
  const UP = path.join(__dirname, '..', 'uploads');
  const files = [
    ...db.prepare('SELECT chemin f FROM document WHERE cabinet_id=? AND chemin IS NOT NULL').all(cab.id).map(r => r.f),
    ...db.prepare('SELECT fichier f FROM convention WHERE cabinet_id=? AND fichier IS NOT NULL').all(cab.id).map(r => r.f),
  ].filter(f => /^[\w.-]+$/.test(f)).map(f => path.join(UP, f));
  if (cab.logo && /^logo_[a-f0-9]+\.(png|jpg|webp)$/.test(cab.logo)) files.push(path.join(UP, 'logos', cab.logo));

  const counts = {};
  db.exec('BEGIN');
  try {
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of TABLES_BY_DECLARATION)
      counts[t] = db.prepare(`DELETE FROM ${t} WHERE declaration_id IN (SELECT id FROM declaration WHERE cabinet_id=?)`).run(cab.id).changes;
    for (const t of TABLES_BY_CABINET) counts[t] = db.prepare(`DELETE FROM ${t} WHERE cabinet_id=?`).run(cab.id).changes;
    db.prepare(`UPDATE cabinet SET nom_affiche=NULL, raison_legale=NULL, logo=NULL, contact_email=NULL, contact_telephone=NULL, adresse=NULL,
      onboarding_json=NULL, updated_at=datetime('now') WHERE id=?`).run(cab.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  let removed = 0;
  for (const f of files) { try { fs.unlinkSync(f); removed++; } catch (_) {} }
  audit(cab.id, null, 'reinitialisation_demo', 'espace_travail', { slug, sauvegarde: path.basename(backup) }, null);
  return { slug, backup, counts, files: removed };
}

module.exports = { resetDemoWorkspace, DemoResetError, CANONICAL_SLUGS };

if (require.main === module) {
  const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const r = resetDemoWorkspace({ slug: arg('slug'), confirm: arg('confirm') });
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    console.log(`Espace « ${r.slug} » remis à blanc : ${total} enregistrement(s) et ${r.files} fichier(s) supprimés ; comptes conservés.`);
    console.log(`Sauvegarde préalable : ${r.backup}`);
    console.log('Reconnectez-vous : l’onboarding repart de la première étape.');
  } catch (e) {
    console.error(e instanceof DemoResetError ? e.message : 'Échec : ' + e.message);
    process.exit(1);
  }
}
