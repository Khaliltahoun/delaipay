'use strict';
/**
 * Console — utilisateurs d'un espace : liste (métadonnées), désactivation / réactivation, rôle, déconnexion forcée,
 * lien de réinitialisation à usage unique (montré une fois), révocation des appareils. Dernier administrateur protégé.
 * Chaque action : journal plateforme (avant → après) + journal de l'espace (« Équipe DelaiPay »).
 */
const { db } = require('../../db');
const store = require('../store');
const workspace = require('../../workspace');
const sessions = require('../../sessions');
const lifecycle = require('../../lifecycle');
const netu = require('../../net');
const { workspaceOrigin } = require('./workspaces');

const actorLabel = req => `Équipe DelaiPay (${req.padmin.email})`;
const err = (res, e) => res.status(e.status || 400).json({ error: e.message, code: e.code || 'refuse' });
function devicesMod() { try { return require('../../devices'); } catch (_) { return null; } }

function listUsers(cabinetId) {
  const dev = devicesMod();
  return db.prepare(`SELECT id, nom, email, role, actif, created_at, derniere_connexion FROM utilisateur WHERE cabinet_id=? ORDER BY actif DESC, role, nom`).all(cabinetId)
    .map(u => ({ ...u, actif: !!u.actif,
      sessionsActives: db.prepare(`SELECT COUNT(*) n FROM user_session WHERE user_id=? AND ${sessions.ACTIVE_SQL}`).get(u.id).n,
      appareils: dev ? dev.countForUser(u.id) : 0 }));
}

module.exports = function (api) {
  const ctx = (req, res) => {
    const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.params.id);
    if (!cab) { res.status(404).json({ error: 'Espace introuvable.', code: 'espace_introuvable' }); return null; }
    if (!req.params.uid) return { cab };
    const u = db.prepare('SELECT * FROM utilisateur WHERE id=? AND cabinet_id=?').get(req.params.uid, cab.id);
    if (!u) { res.status(404).json({ error: 'Utilisateur introuvable dans cet espace.', code: 'utilisateur_introuvable' }); return null; }
    return { cab, u };
  };

  api.get('/workspaces/:id/users', (req, res) => {
    const c = ctx(req, res); if (!c) return;
    res.json({ rows: listUsers(c.cab.id), invitations: workspace.listInvitations(c.cab.id).map(i => ({ email: i.email, role: i.role, statut: i.statut, expires_at: i.expires_at, created_at: i.created_at })) });
  });

  // Rôle / statut : mêmes garde-fous que dans l'espace (dernier administrateur actif protégé, limite d'utilisateurs).
  api.patch('/workspaces/:id/users/:uid', (req, res) => {
    const c = ctx(req, res); if (!c) return;
    const b = req.body || {};
    const patch = {};
    if (b.role !== undefined) patch.role = b.role;
    if (b.actif !== undefined) patch.actif = !!b.actif;
    try {
      const avant = { role: c.u.role, actif: !!c.u.actif };
      const u = workspace.updateUser(c.cab.id, null, c.u.id, patch, { par: actorLabel(req) });
      store.paudit(req.padmin, patch.actif === false ? 'utilisateur_desactive' : patch.actif === true && !avant.actif ? 'utilisateur_reactive' : 'utilisateur_modifie',
        { type: 'espace', id: c.cab.id, libelle: `${c.cab.slug} · ${c.u.email}`, avant, apres: { role: u.role, actif: u.actif } }, req);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  api.post('/workspaces/:id/users/:uid/logout', (req, res) => {
    const c = ctx(req, res); if (!c) return;
    const n = sessions.endForUser(c.u.id, 'deconnexion_forcee');
    lifecycle.tenantAudit(c.cab.id, 'deconnexion_forcee', { compte: c.u.email, sessions_fermees: n }, actorLabel(req), netu.clientIp(req));
    store.paudit(req.padmin, 'deconnexion_forcee', { type: 'espace', id: c.cab.id, libelle: `${c.cab.slug} · ${c.u.email}`, details: { sessions_fermees: n } }, req);
    res.json({ ok: true, sessionsFermees: n });
  });

  // Lien de réinitialisation : jeton montré UNE fois ici, jamais journalisé (le journal ne garde que l'échéance).
  api.post('/workspaces/:id/users/:uid/reset-link', (req, res) => {
    const c = ctx(req, res); if (!c) return;
    if (!c.u.actif) return res.status(409).json({ error: 'Compte désactivé : réactivez-le d’abord.', code: 'compte_desactive' });
    if (c.cab.supprime_le || c.cab.actif === 0) return res.status(409).json({ error: 'Espace suspendu ou supprimé : le lien serait inutilisable.', code: 'espace_inactif' });
    const r = require('../../password-reset').create(c.cab.id, c.u.id, actorLabel(req));
    store.paudit(req.padmin, 'lien_reinitialisation', { type: 'espace', id: c.cab.id, libelle: `${c.cab.slug} · ${c.u.email}`, details: { expire: r.expires_at } }, req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, lien: `${workspaceOrigin(req, c.cab.slug)}/reset#t=${r.token}`, expire: r.expires_at, email: r.email });
  });

  api.post('/workspaces/:id/users/:uid/revoke-devices', (req, res) => {
    const c = ctx(req, res); if (!c) return;
    const dev = devicesMod();
    if (!dev) return res.status(501).json({ error: 'Suivi des appareils indisponible.' });
    const r = dev.revokeAllForUser(c.u.id, actorLabel(req));
    lifecycle.tenantAudit(c.cab.id, 'revocation_appareils', { compte: c.u.email, appareils: r.appareils, sessions_fermees: r.sessions }, actorLabel(req), netu.clientIp(req));
    store.paudit(req.padmin, 'appareils_revoques', { type: 'espace', id: c.cab.id, libelle: `${c.cab.slug} · ${c.u.email}`, details: r }, req);
    res.json({ ok: true, ...r });
  });
};
module.exports.listUsers = listUsers;
