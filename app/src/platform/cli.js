'use strict';
/**
 * Administration de la console plateforme en ligne de commande (accès shell au serveur requis).
 * C'est le SEUL moyen de créer un administrateur plateforme : aucune route web ne le permet.
 *
 *   npm run platform:admin:create -- --email ops@delaipay.com --nom "Nom Prénom"
 *        mot de passe : PLATFORM_ADMIN_PASSWORD (≥ 14 caractères), sinon généré et affiché UNE fois.
 *        La 2FA (TOTP) est enrôlée à la première connexion sur la console (QR code) — obligatoire.
 *   npm run platform:admin -- list
 *   npm run platform:admin -- disable --email X         | enable --email X
 *   npm run platform:admin -- reset-2fa --email X       (appareil perdu ET codes de secours perdus : ré-enrôlement)
 *   npm run platform:admin -- set-password --email X    (PLATFORM_ADMIN_PASSWORD, sinon généré)
 *   npm run platform:admin -- allowlist list | add --cidr 203.0.113.0/24 [--label "Bureau"] | remove --cidr X
 *
 * Chaque commande est inscrite au journal de la plateforme (acteur « cli »).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const argv = process.argv.slice(2);
const args = { _: [] };
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  else args._.push(argv[i]);
}
const mode = process.env.DP_PLATFORM_CLI_MODE || args._[0];
const die = m => { console.error('Refusé : ' + m); process.exit(1); };

const store = require('./store');
const pauth = require('./auth');
const netu = require('../net');
const { db } = store;
const CLI = { id: null, email: 'cli' };

function genPassword() { return crypto.randomBytes(12).toString('base64url') + '-7a'; }
function adminByEmail(email) {
  const a = db.prepare('SELECT * FROM platform_admin WHERE email=?').get(String(email || '').trim().toLowerCase());
  if (!a) die('aucun administrateur plateforme pour cette adresse.');
  return a;
}

try {
  if (mode === 'create') {
    const generated = !process.env.PLATFORM_ADMIN_PASSWORD;
    const password = process.env.PLATFORM_ADMIN_PASSWORD || genPassword();
    const a = pauth.createAdmin({ email: args.email, nom: args.nom, password }, 'cli');
    const host = require('../tenant').consoleHosts()[0] || 'admin.localhost';
    console.log(`Administrateur plateforme créé : ${a.email}`);
    console.log(`  Console : http://${host}:${process.env.PORT || 3000}/  (https://${host}/ en production)`);
    if (generated) console.log(`  Mot de passe (affiché une seule fois) : ${password}`);
    console.log('  À la première connexion : enrôlement 2FA obligatoire (QR code + codes de secours à conserver).');
  } else if (mode === 'list') {
    for (const a of db.prepare('SELECT email, nom, actif, totp_enabled, derniere_connexion FROM platform_admin ORDER BY created_at').all())
      console.log(`${a.actif ? 'actif   ' : 'désactivé'}  2FA:${a.totp_enabled ? 'oui' : 'non'}  ${a.email}  (${a.nom})  dernière connexion : ${a.derniere_connexion || '—'}`);
  } else if (mode === 'disable' || mode === 'enable') {
    const a = adminByEmail(args.email);
    db.prepare('UPDATE platform_admin SET actif=? WHERE id=?').run(mode === 'enable' ? 1 : 0, a.id);
    if (mode === 'disable') db.prepare(`UPDATE platform_session SET ended_at=datetime('now'), end_reason='compte_desactive' WHERE admin_id=? AND ended_at IS NULL`).run(a.id);
    store.paudit(CLI, mode === 'enable' ? 'admin_plateforme_active' : 'admin_plateforme_desactive', { type: 'platform_admin', id: a.id, libelle: a.email, avant: { actif: !!a.actif }, apres: { actif: mode === 'enable' } });
    console.log(`${a.email} : ${mode === 'enable' ? 'réactivé' : 'désactivé (sessions fermées)'}.`);
  } else if (mode === 'reset-2fa') {
    const a = adminByEmail(args.email);
    db.prepare('UPDATE platform_admin SET totp_secret_enc=NULL, totp_enabled=0, totp_last_step=-1 WHERE id=?').run(a.id);
    db.prepare('DELETE FROM platform_recovery_code WHERE admin_id=?').run(a.id);
    db.prepare(`UPDATE platform_session SET ended_at=datetime('now'), end_reason='reinitialisation_2fa' WHERE admin_id=? AND ended_at IS NULL`).run(a.id);
    store.paudit(CLI, 'reinitialisation_2fa', { type: 'platform_admin', id: a.id, libelle: a.email });
    console.log(`${a.email} : 2FA réinitialisée — nouvel enrôlement exigé à la prochaine connexion.`);
  } else if (mode === 'set-password') {
    const a = adminByEmail(args.email);
    const generated = !process.env.PLATFORM_ADMIN_PASSWORD;
    const pw = process.env.PLATFORM_ADMIN_PASSWORD || genPassword();
    const pe = pauth.passwordProblem(pw); if (pe) die(pe);
    db.prepare('UPDATE platform_admin SET password_hash=?, echecs=0, verrouille_jusqua=NULL WHERE id=?').run(bcrypt.hashSync(pw, 12), a.id);
    db.prepare(`UPDATE platform_session SET ended_at=datetime('now'), end_reason='mot_de_passe_change' WHERE admin_id=? AND ended_at IS NULL`).run(a.id);
    store.paudit(CLI, 'mot_de_passe_admin_plateforme', { type: 'platform_admin', id: a.id, libelle: a.email });
    console.log(`${a.email} : mot de passe remplacé.` + (generated ? ` Nouveau mot de passe (affiché une seule fois) : ${pw}` : ''));
  } else if (mode === 'allowlist') {
    const sub = args._[1] || 'list';
    const list = store.getSetting('console_allowlist', []) || [];
    if (sub === 'list') {
      const env = String(process.env.PLATFORM_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!list.length && !env.length) console.log('Aucune restriction d’IP : la console est accessible depuis toute adresse (2FA exigée).');
      for (const e of env) console.log(`${e}  (variable PLATFORM_ALLOWED_IPS)`);
      for (const e of list) console.log(`${e.cidr}  ${e.label || ''}  (ajoutée le ${e.added_at})`);
    } else if (sub === 'add') {
      const p = netu.parseCidr(args.cidr); if (!p.ok) die(p.error);
      if (list.some(e => e.cidr === p.cidr)) die('plage déjà présente.');
      const next = [...list, { cidr: p.cidr, label: String(args.label || '').slice(0, 60) || null, added_at: new Date().toISOString().slice(0, 10) }];
      store.setSetting('console_allowlist', next, 'cli');
      store.paudit(CLI, 'liste_ip_console', { type: 'plateforme', libelle: 'liste d’IP de la console', avant: list, apres: next });
      console.log(`Ajoutée : ${p.cidr}. ATTENTION : la console n’est plus accessible que depuis ces plages.`);
    } else if (sub === 'remove') {
      const p = netu.parseCidr(args.cidr); if (!p.ok) die(p.error);
      const next = list.filter(e => e.cidr !== p.cidr);
      if (next.length === list.length) die('plage absente de la liste.');
      store.setSetting('console_allowlist', next, 'cli');
      store.paudit(CLI, 'liste_ip_console', { type: 'plateforme', libelle: 'liste d’IP de la console', avant: list, apres: next });
      console.log(`Retirée : ${p.cidr}.`);
    } else die('sous-commande inconnue (list | add | remove).');
  } else {
    die('commande inconnue. Voir l’en-tête de src/platform/cli.js.');
  }
} catch (e) { die(e.message); }
