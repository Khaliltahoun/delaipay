'use strict';
/**
 * Console — sessions, appareils et politique d'accès (par espace, par utilisateur, vue globale) ; IP bloquées globales.
 * Aucun contenu métier : navigateur, système, type / modèle d'appareil (indice client uniquement), IP, pays (base locale).
 */
const { db } = require('../../db');
const store = require('../store');
const sessions = require('../../sessions');
const devices = require('../../devices');
const accessPolicy = require('../../access-policy');
const lifecycle = require('../../lifecycle');
const netu = require('../../net');
const geo = require('../../geoip');

const actorLabel = req => `Équipe DelaiPay (${req.padmin.email})`;
const err = (res, e) => res.status(e.status || 400).json({ error: e.message, code: e.code || 'refuse' });
const lim = q => Math.min(1000, Math.max(1, +q || 300));

function sessionRows({ cabinetId, userId, actives = true, limit = 300 }) {
  const w = ['1=1'], a = [];
  if (cabinetId) { w.push('s.cabinet_id=?'); a.push(cabinetId); }
  if (userId) { w.push('s.user_id=?'); a.push(userId); }
  if (actives) w.push(`s.ended_at IS NULL AND s.expires_at > datetime('now')`);
  return db.prepare(`SELECT s.*, COALESCE(u.nom, CASE WHEN s.type='support' THEN 'Assistance DelaiPay' END) user_nom,
      COALESCE(u.email, (SELECT admin_email FROM support_access a WHERE a.id=s.support_access_id)) user_email, c.slug, c.nom cab_nom FROM user_session s
      LEFT JOIN utilisateur u ON u.id=s.user_id LEFT JOIN cabinet c ON c.id=s.cabinet_id
      WHERE ${w.join(' AND ')} ORDER BY s.last_seen_at DESC LIMIT ?`).all(...a, limit)
    .map(x => ({ id: x.id, type: x.type, espace: { id: x.cabinet_id, slug: x.slug, nom: x.cab_nom }, utilisateur: { id: x.user_id, nom: x.user_nom, email: x.user_email },
      ip: x.ip, ipDerniere: x.ip_derniere, pays: x.pays, navigateur: x.navigateur, os: x.os, typeAppareil: x.type_appareil, modele: x.modele,
      debut: x.created_at, vu: x.last_seen_at, expire: x.expires_at, fin: x.ended_at, motifFin: x.end_reason, appareil: x.device_id,
      active: !x.ended_at && Date.parse(x.expires_at.replace(' ', 'T') + 'Z') > Date.now() }));
}
function deviceRows({ cabinetId, userId, statut, limit = 300 }) {
  const w = ['1=1'], a = [];
  if (cabinetId) { w.push('d.cabinet_id=?'); a.push(cabinetId); }
  if (userId) { w.push('d.user_id=?'); a.push(userId); }
  if (statut) { w.push('d.statut=?'); a.push(statut); }
  return db.prepare(`SELECT d.*, u.nom user_nom, u.email user_email, u.role user_role, c.slug FROM device d LEFT JOIN utilisateur u ON u.id=d.user_id LEFT JOIN cabinet c ON c.id=d.cabinet_id
      WHERE ${w.join(' AND ')} ORDER BY (d.statut='en_attente') DESC, d.last_seen DESC LIMIT ?`).all(...a, limit)
    .map(d => ({ ...devices.publicDevice(d), espace: { id: d.cabinet_id, slug: d.slug } }));
}

module.exports = function (api) {
  api.get('/sessions', (req, res) => res.json({ rows: sessionRows({ cabinetId: req.query.cabinet || null, userId: req.query.user || null, actives: req.query.toutes !== '1', limit: lim(req.query.limit) }), geoip: geo.configured() }));
  api.post('/sessions/:sid/revoke', (req, res) => {
    const s = sessions.get(req.params.sid);
    if (!s) return res.status(404).json({ error: 'Session introuvable.', code: 'session_introuvable' });
    const n = sessions.end(s.id, 'deconnexion_forcee');
    const u = db.prepare('SELECT email FROM utilisateur WHERE id=?').get(s.user_id), c = db.prepare('SELECT slug FROM cabinet WHERE id=?').get(s.cabinet_id);
    lifecycle.tenantAudit(s.cabinet_id, 'deconnexion_forcee', { compte: u && u.email, sessions_fermees: n }, actorLabel(req), netu.clientIp(req));
    store.paudit(req.padmin, 'session_revoquee', { type: 'espace', id: s.cabinet_id, libelle: `${c && c.slug} · ${u && u.email}`, details: { session: s.id, navigateur: s.navigateur, ip: s.ip_derniere } }, req);
    res.json({ ok: true });
  });
  api.get('/devices', (req, res) => res.json({ rows: deviceRows({ cabinetId: req.query.cabinet || null, userId: req.query.user || null, statut: req.query.statut || null, limit: lim(req.query.limit) }) }));
  api.post('/devices/:did/:action', (req, res) => {
    const d = devices.get(req.params.did);
    if (!d) return res.status(404).json({ error: 'Appareil introuvable.', code: 'appareil_introuvable' });
    const statut = { approve: 'approuve', refuse: 'refuse', revoke: 'revoque' }[req.params.action];
    if (!statut) return res.status(404).json({ error: 'Action inconnue.' });
    const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(d.cabinet_id);
    const r = devices.decide(d.id, statut, actorLabel(req), { dureeJours: accessPolicy.policyOf(cab).dureeApprobationJours });
    const u = db.prepare('SELECT email FROM utilisateur WHERE id=?').get(d.user_id);
    const det = { appareil: `${d.navigateur || '?'} · ${d.os || '?'}`, compte: u && u.email, avant: d.statut, apres: statut, sessions_fermees: r.sessions };
    lifecycle.tenantAudit(d.cabinet_id, 'appareil_' + statut, det, actorLabel(req), netu.clientIp(req));
    store.paudit(req.padmin, 'appareil_' + statut, { type: 'espace', id: d.cabinet_id, libelle: `${cab && cab.slug} · ${u && u.email}`, avant: { statut: d.statut }, apres: { statut }, details: det }, req);
    res.json({ ok: true, ...r });
  });

  api.get('/workspaces/:id/security', (req, res) => {
    const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.params.id);
    if (!cab) return res.status(404).json({ error: 'Espace introuvable.', code: 'espace_introuvable' });
    const p = accessPolicy.policyOf(cab);
    res.json({ politique: p, mode: accessPolicy.modeLabel(p), ipConsole: netu.clientIp(req), ipBloqueesGlobales: accessPolicy.globalBlocklist(),
      appareils: deviceRows({ cabinetId: cab.id }), sessions: sessionRows({ cabinetId: cab.id }), geoip: geo.configured() });
  });
  // CONS-IP : aperçu AVANT enregistrement — sessions et utilisateurs qui seraient coupés (dernière IP vue).
  api.post('/workspaces/:id/security/preview', (req, res) => {
    const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.params.id);
    if (!cab) return res.status(404).json({ error: 'Espace introuvable.', code: 'espace_introuvable' });
    try { res.json({ slug: cab.slug, ...accessPolicy.previewImpact(cab.id, req.body || {}) }); } catch (e) { err(res, e); }
  });
  api.put('/workspaces/:id/security/policy', (req, res) => {
    const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.params.id);
    if (!cab) return res.status(404).json({ error: 'Espace introuvable.', code: 'espace_introuvable' });
    try {
      // Si quelqu'un serait coupé : confirmation explicite = saisie exacte de l'identifiant de l'espace.
      const impact = accessPolicy.previewImpact(cab.id, req.body || {});
      if (impact.coupure && String((req.body || {}).confirmation || '').trim() !== cab.slug)
        return res.status(409).json({ error: `Cette politique couperait ${impact.sessions.length} session(s) et ${impact.utilisateurs.length} utilisateur(s) : saisissez l’identifiant « ${cab.slug} » pour confirmer.`, code: 'confirmation_requise', impact });
      const r = accessPolicy.savePolicy(cab.id, req.body || {}, { actorLabel: actorLabel(req), currentIp: netu.clientIp(req), requireCurrentIp: false });
      lifecycle.tenantAudit(cab.id, 'politique_acces', { avant: r.avant, apres: r.apres, appareils_approuves: r.approuves }, actorLabel(req), netu.clientIp(req));
      store.paudit(req.padmin, 'politique_acces', { type: 'espace', id: cab.id, libelle: cab.slug, avant: r.avant, apres: r.apres, details: { appareils_approuves: r.approuves, avertissements: r.avertissements,
        coupure_confirmee: impact.coupure ? { sessions: impact.sessions.length, utilisateurs: impact.utilisateurs.map(u => `${u.email} (${u.ip})`) } : null } }, req);
      res.json({ ok: true, avertissements: r.avertissements, approuves: r.approuves });
    } catch (e) { err(res, e); }
  });

  api.get('/ip-blocklist', (req, res) => res.json({ rows: accessPolicy.globalBlocklist(), ip: netu.clientIp(req) }));
  api.post('/ip-blocklist/preview', (req, res) => {
    try { res.json(accessPolicy.previewGlobalBlock((req.body || {}).rows || [])); } catch (e) { err(res, e); }
  });
  api.put('/ip-blocklist', (req, res) => {
    try {
      const pv = accessPolicy.previewGlobalBlock((req.body || {}).rows || []);
      if (pv.coupure && String((req.body || {}).confirmation || '') !== 'BLOQUER')
        return res.status(409).json({ error: `Cette liste couperait ${pv.sessions.length} session(s) active(s) : saisissez BLOQUER pour confirmer.`, code: 'confirmation_requise', impact: pv });
      const next = accessPolicy.normalizeList((req.body || {}).rows || [], 'IP bloquées (plateforme)');
      const avant = accessPolicy.globalBlocklist();
      store.setSetting('ip_bloquees', next, req.padmin.email);
      store.paudit(req.padmin, 'ip_bloquees_globales', { type: 'plateforme', libelle: 'tous les espaces', avant, apres: next }, req);
      res.json({ ok: true, rows: next });
    } catch (e) { err(res, e); }
  });
};
module.exports.sessionRows = sessionRows;
module.exports.deviceRows = deviceRows;
