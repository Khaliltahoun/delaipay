'use strict';
/**
 * Applique le schéma (tables / colonnes / index, idempotent et ADDITIF) de tous les modules avant le redémarrage
 * d'une nouvelle version — appelé par deploy/deploy.sh APRÈS la sauvegarde de pré-déploiement.
 * Convention : les migrations n'ajoutent que des tables et des colonnes (jamais de suppression ni de renommage),
 * ce qui permet de revenir à la version précédente sans restaurer la base.
 */
const { db, DB_PATH } = require('../db');
for (const m of ['../platform/store', '../sessions', '../devices', '../login-activity', '../lifecycle', '../access-policy', '../password-reset', '../support-access']) require(m);
const tables = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table'`).get().n;
const integ = Object.values(db.prepare('PRAGMA quick_check').get())[0];
if (integ !== 'ok') { console.error('Base : contrôle rapide en échec — ' + integ); process.exit(1); }
console.log(`Schéma à jour : ${tables} tables · ${DB_PATH}`);
