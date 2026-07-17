'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'delaipay.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS cabinet (
  id TEXT PRIMARY KEY, nom TEXT NOT NULL, slug TEXT, logo TEXT,
  plan TEXT DEFAULT 'pro', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS utilisateur (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, nom TEXT, email TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT DEFAULT 'collaborateur',
  initiales TEXT, titre TEXT, actif INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(cabinet_id, email)
);
CREATE TABLE IF NOT EXISTS entreprise (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL,
  raison_sociale TEXT NOT NULL, ice TEXT, if_fiscal TEXT, rc TEXT,
  forme_juridique TEXT, secteur TEXT, ville TEXT, adresse TEXT,
  ca_ht REAL DEFAULT 0, exercice_ref INTEGER,
  email TEXT, telephone TEXT, expert_responsable TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS fournisseur (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT NOT NULL,
  raison_sociale TEXT, ice TEXT, if_fiscal TEXT, rc TEXT, adresse TEXT, secteur TEXT,
  email TEXT, delai_applicable INTEGER DEFAULT 60,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS convention (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT NOT NULL,
  fournisseur_id TEXT, objet TEXT, delai_convenu INTEGER DEFAULT 120,
  date_signature TEXT, date_debut TEXT, date_fin TEXT,
  statut TEXT DEFAULT 'valide', conforme INTEGER DEFAULT 1,
  fichier TEXT, fichier_nom TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS facture (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT NOT NULL,
  fournisseur_id TEXT, numero TEXT, designation TEXT,
  mht REAL, tva REAL, ttc REAL, taux_tva REAL, mode_reglement TEXT,
  date_facture TEXT, date_paiement TEXT, annee INTEGER, periode INTEGER, trimestre INTEGER,
  en_litige INTEGER DEFAULT 0, source_import TEXT, import_id TEXT, fichier TEXT,
  -- champs calculés (dénormalisés)
  delai_applicable INTEGER, delai_ecoule INTEGER, date_limite TEXT,
  retard_jours INTEGER, n_mois INTEGER, a_declarer INTEGER DEFAULT 0,
  taux_bam REAL, taux_total REAL, base_amende REAL, montant_amende REAL,
  couleur_risque TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS taux_bam (
  id TEXT PRIMARY KEY, cabinet_id TEXT, taux REAL NOT NULL,
  date_debut TEXT NOT NULL, date_fin TEXT, reference TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS declaration (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT NOT NULL,
  annee INTEGER, trimestre INTEGER, ca_ht REAL, etat_activite TEXT DEFAULT 'normale',
  statut TEXT DEFAULT 'brouillon', type_visa TEXT,
  montant_total_ttc REAL DEFAULT 0, montant_non_paye REAL DEFAULT 0,
  montant_paye_hors_delai REAL DEFAULT 0, montant_total_amende REAL DEFAULT 0,
  montant_litiges REAL DEFAULT 0, sanctions_retard REAL DEFAULT 0, montant_a_verser REAL DEFAULT 0,
  nb_lignes INTEGER DEFAULT 0, date_edition TEXT,
  created_at TEXT DEFAULT (datetime('now')), UNIQUE(entreprise_id, annee, trimestre)
);
CREATE TABLE IF NOT EXISTS ligne_declaration (
  id TEXT PRIMARY KEY, declaration_id TEXT NOT NULL, facture_id TEXT,
  fournisseur_if TEXT, fournisseur_nom TEXT, ttc REAL, non_paye REAL,
  paye_hors_delai REAL, retard_jours INTEGER, montant_amende REAL
);
CREATE TABLE IF NOT EXISTS visa (
  id TEXT PRIMARY KEY, declaration_id TEXT NOT NULL, type TEXT, montant_vise REAL,
  conclusion TEXT, reference TEXT, signataire TEXT, lieu TEXT, date_signature TEXT,
  texte TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS anomalie (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT,
  type TEXT, gravite TEXT DEFAULT 'moyenne', details TEXT, entite TEXT, entite_id TEXT,
  statut TEXT DEFAULT 'ouverte', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS document (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT,
  type TEXT, nom TEXT, chemin TEXT, taille INTEGER, mime TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, cabinet_id TEXT, user_id TEXT, action TEXT, entite TEXT,
  details TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_ent_cab   ON entreprise(cabinet_id);
CREATE INDEX IF NOT EXISTS ix_four_ent  ON fournisseur(entreprise_id);
CREATE INDEX IF NOT EXISTS ix_fac_ent   ON facture(entreprise_id);
CREATE INDEX IF NOT EXISTS ix_fac_period ON facture(entreprise_id, annee, trimestre);
CREATE INDEX IF NOT EXISTS ix_fac_cab    ON facture(cabinet_id, annee, trimestre);
CREATE INDEX IF NOT EXISTS ix_fac_four   ON facture(fournisseur_id);
CREATE INDEX IF NOT EXISTS ix_conv_four ON convention(fournisseur_id);
CREATE INDEX IF NOT EXISTS ix_audit_cab ON audit_log(cabinet_id, created_at);
`);

/* -------------------------------------------------- fournisseur delai column patch (idempotent) */
try { db.exec('ALTER TABLE fournisseur ADD COLUMN delai_applicable INTEGER DEFAULT 60'); } catch (_) {}
try { db.exec('ALTER TABLE document ADD COLUMN import_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE document ADD COLUMN nb_factures INTEGER DEFAULT 0'); } catch (_) {}

/* ==================================================================================
 * PÉRIODES TRIMESTRIELLES & IMPORTS CONTRÔLÉS (idempotent — sûr à relancer)
 * ================================================================================== */
db.exec(`
CREATE TABLE IF NOT EXISTS periode_declaration (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT NOT NULL,
  annee INTEGER NOT NULL, trimestre INTEGER NOT NULL,
  date_debut TEXT, date_fin TEXT, mois_traitement INTEGER, annee_traitement INTEGER,
  statut TEXT DEFAULT 'ouverte',
  date_cloture TEXT, cloturee_par TEXT, date_reouverture TEXT, motif_reouverture TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(entreprise_id, annee, trimestre)
);
CREATE TABLE IF NOT EXISTS import_lot (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, entreprise_id TEXT NOT NULL,
  document_id TEXT, annee INTEGER, trimestre INTEGER,
  source_nom TEXT, feuille TEXT, ligne_entete INTEGER, mapping_json TEXT,
  statut TEXT DEFAULT 'confirme',
  nb_lignes_total INTEGER DEFAULT 0, nb_lignes_valides INTEGER DEFAULT 0,
  nb_lignes_ignorees INTEGER DEFAULT 0, nb_lignes_rejetees INTEGER DEFAULT 0,
  nb_doublons INTEGER DEFAULT 0, total_ttc REAL DEFAULT 0,
  empreinte_fichier TEXT, utilisateur_id TEXT,
  created_at TEXT DEFAULT (datetime('now')), confirmed_at TEXT, cancelled_at TEXT
);
CREATE TABLE IF NOT EXISTS import_ligne (
  id TEXT PRIMARY KEY, import_lot_id TEXT NOT NULL, cabinet_id TEXT, entreprise_id TEXT,
  numero_ligne INTEGER, feuille TEXT,
  donnees_brutes_json TEXT, donnees_normalisees_json TEXT,
  statut TEXT, motif TEXT, champ TEXT, facture_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS modele_mapping (
  id TEXT PRIMARY KEY, cabinet_id TEXT NOT NULL, nom TEXT NOT NULL,
  type_fichier TEXT, signature_colonnes TEXT, feuille TEXT, ligne_entete INTEGER,
  mapping_json TEXT, transformations_json TEXT,
  created_by TEXT, created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), derniere_utilisation TEXT
);
`);

// Colonnes de traçabilité période/lot (idempotent)
for (const stmt of [
  "ALTER TABLE facture ADD COLUMN import_lot_id TEXT",
  "ALTER TABLE facture ADD COLUMN annee_origine INTEGER",       // période comptable = trimestre de la date de facture
  "ALTER TABLE facture ADD COLUMN trimestre_origine INTEGER",
  "ALTER TABLE facture ADD COLUMN incidence_reportee INTEGER DEFAULT 0",
  "ALTER TABLE facture ADD COLUMN facture_origine_id TEXT",
  "ALTER TABLE document ADD COLUMN annee INTEGER",
  "ALTER TABLE document ADD COLUMN trimestre INTEGER",
  "ALTER TABLE document ADD COLUMN import_lot_id TEXT",
  "ALTER TABLE document ADD COLUMN empreinte TEXT",
  "ALTER TABLE document ADD COLUMN utilisateur_id TEXT",
  "ALTER TABLE document ADD COLUMN statut TEXT DEFAULT 'traite'",
  "ALTER TABLE anomalie ADD COLUMN annee INTEGER",
  "ALTER TABLE anomalie ADD COLUMN trimestre INTEGER",
  "ALTER TABLE anomalie ADD COLUMN import_lot_id TEXT",
]) { try { db.exec(stmt); } catch (_) {} }

db.exec(`
CREATE INDEX IF NOT EXISTS ix_perdecl_ent   ON periode_declaration(entreprise_id, annee, trimestre);
CREATE INDEX IF NOT EXISTS ix_perdecl_cab   ON periode_declaration(cabinet_id, annee, trimestre);
CREATE INDEX IF NOT EXISTS ix_lot_ent       ON import_lot(entreprise_id, annee, trimestre);
CREATE INDEX IF NOT EXISTS ix_lot_cab       ON import_lot(cabinet_id, statut);
CREATE INDEX IF NOT EXISTS ix_ligne_lot     ON import_ligne(import_lot_id, statut);
CREATE INDEX IF NOT EXISTS ix_fac_lot       ON facture(import_lot_id);
CREATE INDEX IF NOT EXISTS ix_fac_origine   ON facture(entreprise_id, annee_origine, trimestre_origine);
CREATE INDEX IF NOT EXISTS ix_doc_ent_per   ON document(entreprise_id, annee, trimestre);
CREATE INDEX IF NOT EXISTS ix_ano_ent_per   ON anomalie(entreprise_id, annee, trimestre);
CREATE INDEX IF NOT EXISTS ix_mapping_cab   ON modele_mapping(cabinet_id, type_fichier);
`);

/* ------------------------------------------------------------- taux BAM provider */
function tauxAt(y, m, cabinetId) {
  const dateStr = `${y}-${String(m).padStart(2, '0')}-15`;
  const row = db.prepare(
    `SELECT taux FROM taux_bam
      WHERE (cabinet_id IS NULL OR cabinet_id = ?)
        AND date_debut <= ?
        AND (date_fin IS NULL OR date_fin >= ?)
      ORDER BY (cabinet_id IS NULL) ASC, date_debut DESC LIMIT 1`
  ).get(cabinetId || null, dateStr, dateStr);
  return row ? row.taux : 0.0225;
}

/* ------------------------------------------------------------------- audit */
function audit(cabinetId, userId, action, entite, details, ip) {
  const { uid } = require('./util');
  try {
    db.prepare(`INSERT INTO audit_log (id, cabinet_id, user_id, action, entite, details, ip)
                VALUES (?,?,?,?,?,?,?)`)
      .run(uid('log'), cabinetId || null, userId || null, action, entite || null,
           typeof details === 'string' ? details : JSON.stringify(details || {}), ip || null);
  } catch (e) { /* audit ne doit jamais casser le flux */ }
}

module.exports = { db, tauxAt, audit, DB_PATH };
