'use strict';
/**
 * Emplacements des données HORS du code (3B) : en déploiement, chaque version vit dans son propre répertoire
 * (releases/<id>) et les données doivent survivre aux mises à jour et aux retours arrière.
 *   DB_PATH      base SQLite (défaut app/data/delaipay.db)
 *   UPLOADS_DIR  fichiers téléversés : justificatifs, logos, imports (défaut app/uploads)
 */
const path = require('path');
const APP = path.join(__dirname, '..');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(APP, 'uploads');
module.exports = { UPLOADS_DIR, APP };
