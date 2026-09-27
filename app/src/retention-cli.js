'use strict';
/**
 * Purge des données de connexion au-delà de la durée de rétention (12 mois par défaut, réglable dans la console).
 *
 *   DB_PATH=… npm run platform:purge                 aperçu (aucune suppression)
 *   DB_PATH=… npm run platform:purge -- --confirmer  suppression effective, inscrite au journal de la plateforme
 *   DB_PATH=… npm run platform:purge -- --mois 24    durée ponctuelle différente (sans modifier le réglage)
 *
 * Tables concernées UNIQUEMENT : user_session, device, login_event. Jamais les données comptables ni les journaux d'audit.
 */
const argv = process.argv.slice(2);
const flag = k => argv.includes('--' + k);
const val = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const retention = require('./retention');
const store = require('./platform/store');
const m = val('mois') ? +val('mois') : retention.months();
if (!Number.isInteger(m) || m < 1 || m > 120) { console.error('Refusé : --mois doit être un entier de 1 à 120.'); process.exit(1); }
const p = retention.plan(m);
console.log(`Rétention : ${m} mois. Tables concernées : ${retention.TABLES.join(', ')} (jamais les données comptables ni les journaux d'audit).`);
console.log(`  Sessions terminées ou expirées : ${p.sessions}\n  Appareils inutilisés : ${p.appareils}\n  Évènements de connexion : ${p.connexions}`);
if (!flag('confirmer')) { console.log('Aperçu uniquement. Relancez avec --confirmer pour supprimer.'); process.exit(0); }
const r = retention.purge(m);
store.paudit({ id: null, email: 'cli' }, 'purge_retention', { type: 'plateforme', libelle: 'données de connexion', details: r });
console.log(`Supprimé : ${r.sessions} session(s), ${r.appareils} appareil(s), ${r.connexions} évènement(s) de connexion.`);
