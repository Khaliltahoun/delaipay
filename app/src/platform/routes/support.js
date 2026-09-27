'use strict';
/**
 * Console — accès d'assistance : motif obligatoire, 2 h au maximum, lecture seule, fin automatique ;
 * inscrit au journal de la plateforme ET au journal de l'espace (visible par l'administrateur de l'espace).
 */
const store = require('../store');
const support = require('../../support-access');
const { workspaceOrigin } = require('./workspaces');
const { db } = require('../../db');

const err = (res, e) => res.status(e.status || 400).json({ error: e.message, code: e.code || 'refuse' });
const linkOf = (req, a, token) => `${workspaceOrigin(req, db.prepare('SELECT slug FROM cabinet WHERE id=?').get(a.cabinet_id).slug)}/support#t=${token}`;

module.exports = function (api) {
  api.get('/workspaces/:id/support', (req, res) => res.json({ rows: support.listForCabinet(req.params.id), maxMinutes: support.MAX_MIN }));
  api.get('/support/active', (req, res) => res.json({ rows: support.listActive().map(a => ({ id: a.id, espace: { id: a.cabinet_id, slug: a.slug }, admin: a.admin_email, motif: a.motif, debut: a.debut, fin: a.fin })) }));
  api.post('/workspaces/:id/support', (req, res) => {
    try {
      const b = req.body || {};
      const { access: a, token } = support.open(req.params.id, req.padmin, { motif: b.motif, dureeMinutes: +b.dureeMinutes });
      const slug = db.prepare('SELECT slug FROM cabinet WHERE id=?').get(a.cabinet_id).slug;
      store.paudit(req.padmin, 'acces_support_ouvert', { type: 'espace', id: a.cabinet_id, libelle: slug, details: { motif: a.motif, debut: a.debut, fin: a.fin, lecture_seule: true } }, req);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, id: a.id, fin: a.fin, lien: linkOf(req, a, token) });
    } catch (e) { err(res, e); }
  });
  api.post('/support/:sid/link', (req, res) => {
    try { const { access: a, token } = support.reissueLink(req.params.sid, req.padmin); res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, lien: linkOf(req, a, token), fin: a.fin }); }
    catch (e) { err(res, e); }
  });
  api.post('/support/:sid/end', (req, res) => {
    try {
      const a = support.end(req.params.sid, req.padmin);
      const slug = db.prepare('SELECT slug FROM cabinet WHERE id=?').get(a.cabinet_id).slug;
      store.paudit(req.padmin, 'acces_support_termine', { type: 'espace', id: a.cabinet_id, libelle: slug, details: { motif: a.motif, fin_effective: a.fin_effective } }, req);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });
};
