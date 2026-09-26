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

/**
 * Scénario « vérification » (INC 2.2) sur un espace de démonstration FRAÎCHEMENT remis à blanc — jamais HLZ.
 * Données fictives : client STE ATLAS VERIF SARL, 36 factures T1 2026 importées par le chemin de l'assistant (anomalies
 * rattachées au trimestre), conventions : BETA (avec justificatif, signée le 15/12/2025 → signature rétroactive pour
 * les factures antérieures), KORAL (sans justificatif), ALPHA (effet après T1 → « hors période de validité »).
 * Utilisateurs supplémentaires (mot de passe DEMO_PASSWORD) : comptable@<slug>.demo (Comptable), lecture@<slug>.demo (Lecture seule).
 */
function prepareVerificationScenario({ slug, env = process.env }) {
  if (CANONICAL_SLUGS.has(slug)) throw new DemoResetError('Refusé : le scénario de vérification ne se prépare jamais sur l’espace de référence.');
  const { db, audit } = require('./db');
  const { uid, normalizeIce } = require('./util');
  const importer = require('./importer');
  const fx = require('./demo-fixture');
  const { hashPassword } = require('./auth');
  const cab = db.prepare('SELECT * FROM cabinet WHERE lower(slug)=?').get(slug);
  if (!cab) throw new DemoResetError(`Aucun espace « ${slug} » dans cette base.`);
  if (db.prepare('SELECT 1 FROM entreprise WHERE cabinet_id=?').get(cab.id)) throw new DemoResetError('Refusé : l’espace n’est pas vierge — remettez-le d’abord à blanc.');
  const admin = db.prepare("SELECT * FROM utilisateur WHERE cabinet_id=? AND role='admin' ORDER BY created_at LIMIT 1").get(cab.id);
  const ent = uid('ent');
  db.prepare(`INSERT INTO entreprise (id,cabinet_id,raison_sociale,ice,if_fiscal,forme_juridique,ville,ca_ht,exercice_ref,expert_responsable)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(ent, cab.id, 'STE ATLAS VERIF SARL', '009970000000088', '99700088', 'SARL', 'Rabat', 60457607.22, 2026, admin ? admin.nom : null);
  const r = importer.confirmImport(fx.demoWorkbookBuffer(), { sheetName: 'Feuil1', headerRow: 0,
    mapping: { numero: 0, designation: 1, mht: 2, tva: 3, ttc: 4, four_if: 5, four_nom: 6, four_ice: 7, taux_tva: 8, date_paiement: 10, date_facture: 11 },
    cabinetId: cab.id, entrepriseId: ent, annee: 2026, trimestre: 1, sourceName: 'scenario-verification-t1-2026.xlsx', userId: admin ? admin.id : null });
  const four = nom => db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND raison_sociale=?').get(ent, nom).id;
  const UP = path.join(__dirname, '..', 'uploads'); fs.mkdirSync(UP, { recursive: true });
  // Justificatif PDF minimal (fictif) : lisible par un navigateur, sans sélecteur de fichiers.
  const pdf = n => { const f = uid('up') + '.pdf'; fs.writeFileSync(path.join(UP, f), Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 14 Tf 60 780 Td (Convention fictive de demonstration - ${n}) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1')); return f; };
  const conv = (nom, o) => db.prepare(`INSERT INTO convention (id,cabinet_id,entreprise_id,fournisseur_id,objet,delai_convenu,statut,conforme,date_signature,date_debut,date_fin,fichier,fichier_nom)
    VALUES (?,?,?,?,?,120,'valide',1,?,?,?,?,?)`).run(uid('conv'), cab.id, ent, four(nom), 'Convention relative aux délais de paiement', o.sig || null, o.deb || null, o.fin || null, o.file || null, o.file ? `Convention ${nom} (démo).pdf` : null);
  conv('BETA EXPRESS SARL', { sig: '2025-12-15', deb: '2026-01-01', file: pdf('BETA') });
  conv('KORAL ENGINS SA', { sig: '2025-11-02', deb: '2026-01-01' });
  conv('ALPHA PIECES AUTO', { sig: '2026-04-20', deb: '2026-05-01' });
  const users = [];
  if (env.DEMO_PASSWORD) for (const [role, nom, loc] of [['collaborateur', 'Nadia Comptable', 'comptable'], ['lecture', 'Omar Lecture', 'lecture']]) {
    const email = `${loc}@${slug}.demo`;
    if (db.prepare('SELECT 1 FROM utilisateur WHERE cabinet_id=? AND email=?').get(cab.id, email)) continue;
    db.prepare(`INSERT INTO utilisateur (id,cabinet_id,nom,email,password_hash,role,initiales,actif) VALUES (?,?,?,?,?,?,?,1)`)
      .run(uid('usr'), cab.id, nom, email, hashPassword(env.DEMO_PASSWORD), role, nom.split(' ').map(x => x[0]).join(''));
    users.push(email);
  }
  audit(cab.id, null, 'preparation_demo', 'espace_travail', { slug, scenario: 'verification', factures: r.imported }, null);
  return { entrepriseId: ent, factures: r.imported, users };
}

module.exports = { resetDemoWorkspace, prepareVerificationScenario, DemoResetError, CANONICAL_SLUGS };

if (require.main === module) {
  const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const r = resetDemoWorkspace({ slug: arg('slug'), confirm: arg('confirm') });
    const prep = arg('prepare');
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    console.log(`Espace « ${r.slug} » remis à blanc : ${total} enregistrement(s) et ${r.files} fichier(s) supprimés ; comptes conservés.`);
    console.log(`Sauvegarde préalable : ${r.backup}`);
    if (prep === 'verification') {
      const v = prepareVerificationScenario({ slug: r.slug });
      console.log(`Scénario « vérification » prêt : client STE ATLAS VERIF SARL, ${v.factures} factures T1 2026, conventions BETA (avec justificatif), KORAL (sans), ALPHA (hors validité).`);
      if (v.users.length) console.log('Utilisateurs ajoutés : ' + v.users.join(', ') + ' (mot de passe : DEMO_PASSWORD).');
    } else if (prep) throw new DemoResetError(`Scénario inconnu : « ${prep} » (disponible : verification).`);
    else console.log('Reconnectez-vous : l’onboarding repart de la première étape.');
  } catch (e) {
    console.error(e instanceof DemoResetError ? e.message : 'Échec : ' + e.message);
    process.exit(1);
  }
}
