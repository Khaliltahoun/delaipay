'use strict';
/**
 * Console — espaces de travail : liste, création (premier administrateur INVITÉ), identité, abonnement,
 * limites, suspension / réactivation, export puis suppression douce, restauration, maintenance.
 * Chaque écriture est inscrite au journal de la plateforme ET, quand elle concerne un espace, au journal de cet espace.
 */
const path = require('path');
const multer = require('multer');
const { db } = require('../../db');
const store = require('../store');
const lifecycle = require('../../lifecycle');
const workspace = require('../../workspace');
const tenant = require('../../tenant');
const views = require('../workspaces');
const netu = require('../../net');

const upload = multer({ dest: require('../../paths').UPLOADS_DIR, limits: { fileSize: 1024 * 1024 } });
const actorLabel = req => `Équipe DelaiPay (${req.padmin.email})`;
const err = (res, e) => res.status(e.status || 400).json({ error: e.message, code: e.code || 'refuse' });
const cab = id => db.prepare('SELECT * FROM cabinet WHERE id=?').get(id);
function need(req, res) {
  const c = cab(req.params.id);
  if (!c) { res.status(404).json({ error: 'Espace introuvable.', code: 'espace_introuvable' }); return null; }
  return c;
}
/** Adresse de l'espace, déduite de l'hôte de la console (admin.localhost:4100 → prime.localhost:4100). */
function workspaceOrigin(req, slug) {
  const host = String(req.headers.host || '');
  const port = (host.match(/:(\d+)$/) || [])[1];
  const bare = host.replace(/:\d+$/, '').toLowerCase();
  const base = bare.startsWith('admin.') ? bare.slice(6) : (tenant.baseDomains()[0] || 'localhost');
  return `${req.protocol}://${slug}.${base}${port ? ':' + port : ''}`;
}
const pick = (o, keys) => { const r = {}; for (const k of keys) r[k] = o[k] === undefined ? null : o[k]; return r; };
const IDENTITY_COLS = ['nom', 'nom_affiche', 'raison_legale', 'adresse', 'ice', 'if_fiscal', 'contact_nom', 'contact_email', 'contact_telephone', 'couleur_primaire', 'max_utilisateurs', 'max_clients', 'plan'];

module.exports = function (api) {
  api.get('/workspaces', (req, res) => res.json({ rows: views.list() }));

  api.get('/workspaces/check-slug', (req, res) => {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    if (tenant.RESERVED.has(slug)) return res.json({ ok: false, error: `Cet identifiant est réservé : « ${slug} » est utilisé par la plateforme.` });
    if (!tenant.SLUG_RE.test(slug)) return res.json({ ok: false, error: '2 à 40 caractères : lettres minuscules, chiffres et tirets (ni au début ni à la fin).' });
    if (db.prepare('SELECT 1 FROM cabinet WHERE lower(slug)=?').get(slug)) return res.json({ ok: false, error: `« ${slug} » est déjà utilisé.` });
    res.json({ ok: true, adresse: workspaceOrigin(req, slug) });
  });

  // Création : une transaction (espace + invitation du premier administrateur). Le lien est montré UNE fois.
  api.post('/workspaces', (req, res) => {
    const b = req.body || {};
    try {
      const r = workspace.createWorkspace({
        slug: b.slug, nom: b.nom, nomAffiche: b.nomAffiche, raisonLegale: b.raisonLegale, adresse: b.adresse, ice: b.ice, ifFiscal: b.ifFiscal,
        contactNom: b.contactNom, contactEmail: b.contactEmail, contactTelephone: b.contactTelephone, primaryColor: b.couleur,
        plan: b.plan && lifecycle.PLANS[b.plan] ? b.plan : 'pro', maxUtilisateurs: b.maxUtilisateurs, maxClients: b.maxClients,
        admin: { email: b.adminEmail, invite: true }, par: actorLabel(req),
      });
      if (b.abonnement && (b.abonnement.date_debut || b.abonnement.date_fin || b.abonnement.montant)) {
        try { lifecycle.saveSubscription(r.cabinetId, { plan: b.plan, ...b.abonnement }, req.padmin.email); }
        catch (e) { /* l'espace est créé ; l'abonnement invalide est signalé sans défaire la création */ r.abonnementErreur = e.message; }
      }
      const link = `${workspaceOrigin(req, r.slug)}/invite#t=${r.invitation.token}`;
      store.paudit(req.padmin, 'espace_cree', { type: 'espace', id: r.cabinetId, libelle: r.slug,
        apres: { slug: r.slug, nom: b.nom, plan: b.plan || 'pro', admin_invite: r.invitation.email, limites: { utilisateurs: b.maxUtilisateurs || null, clients: b.maxClients || null } } }, req);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, id: r.cabinetId, slug: r.slug, adresse: workspaceOrigin(req, r.slug),
        invitation: { email: r.invitation.email, lien: link, expire: r.invitation.expires_at }, abonnementErreur: r.abonnementErreur || null });
    } catch (e) { err(res, e); }
  });

  api.get('/workspaces/:id', (req, res) => {
    const d = views.detail(req.params.id);
    if (!d) return res.status(404).json({ error: 'Espace introuvable.', code: 'espace_introuvable' });
    d.adresse = d.slug ? workspaceOrigin(req, d.slug) : null;
    d.journal = store.listAudit({ cibleType: 'espace', cibleId: req.params.id, limit: 50 });
    d.invitationAdmin = db.prepare(`SELECT email, expires_at, accepted_at, revoked_at FROM invitation WHERE cabinet_id=? AND role='admin' AND created_by IS NULL ORDER BY created_at DESC LIMIT 1`).get(req.params.id) || null;
    res.json(d);
  });

  api.patch('/workspaces/:id', (req, res) => {
    const c = need(req, res); if (!c) return;
    const b = req.body || {};
    const vals = {};
    try {
      const txt = (k, col, max, re, msg) => {
        if (b[k] === undefined) return;
        const v = b[k] == null ? '' : String(b[k]).trim();
        if (v.length > max) throw new lifecycle.LifecycleError(`${msg || k} : ${max} caractères maximum.`);
        if (v && re && !re.test(v.replace(/\s/g, ''))) throw new lifecycle.LifecycleError(msg);
        vals[col] = v ? (re ? v.replace(/\s/g, '') : v) : null;
      };
      txt('nom', 'nom', 120); txt('nomAffiche', 'nom_affiche', 80); txt('raisonLegale', 'raison_legale', 160); txt('adresse', 'adresse', 240);
      txt('ice', 'ice', 20, /^\d{15}$/, 'ICE : 15 chiffres.'); txt('ifFiscal', 'if_fiscal', 12, /^\d{1,12}$/, 'Identifiant fiscal : chiffres uniquement.');
      txt('contactNom', 'contact_nom', 120); txt('contactEmail', 'contact_email', 120, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'E-mail de contact invalide.'); txt('contactTelephone', 'contact_telephone', 40);
      if ('nom' in vals && !vals.nom) throw new lifecycle.LifecycleError('Le nom de l’espace est obligatoire.');
      if (b.couleur !== undefined) { if (b.couleur && !/^#[0-9a-fA-F]{6}$/.test(b.couleur)) throw new lifecycle.LifecycleError('Couleur : format #RRGGBB.'); vals.couleur_primaire = b.couleur ? b.couleur.toUpperCase() : null; }
      for (const [k, col] of [['maxUtilisateurs', 'max_utilisateurs'], ['maxClients', 'max_clients']]) {
        if (b[k] === undefined) continue;
        if (b[k] == null || b[k] === '') { vals[col] = null; continue; }
        const n = +b[k]; if (!Number.isInteger(n) || n < 1 || n > 100000) throw new lifecycle.LifecycleError('Limite invalide : nombre entier positif.');
        vals[col] = n;
      }
      if (b.plan !== undefined) { if (!lifecycle.PLANS[b.plan]) throw new lifecycle.LifecycleError('Formule inconnue.'); vals.plan = b.plan; }
    } catch (e) { return err(res, e); }
    const cols = Object.keys(vals).filter(k => IDENTITY_COLS.includes(k));
    if (!cols.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni.' });
    const avant = pick(c, cols);
    db.prepare(`UPDATE cabinet SET ${cols.map(k => k + '=?').join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...cols.map(k => vals[k]), c.id);
    const apres = pick(cab(c.id), cols);
    store.paudit(req.padmin, 'espace_modifie', { type: 'espace', id: c.id, libelle: c.slug, avant, apres }, req);
    lifecycle.tenantAudit(c.id, 'update', { avant, apres }, actorLabel(req), netu.clientIp(req));
    res.json({ ok: true });
  });

  api.post('/workspaces/:id/logo', upload.single('file'), (req, res) => {
    const c = need(req, res); if (!c) return;
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    try {
      workspace.saveLogo(c.id, req.file.path, req.file.size);
      store.paudit(req.padmin, 'espace_logo', { type: 'espace', id: c.id, libelle: c.slug, details: { taille: req.file.size } }, req);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  api.put('/workspaces/:id/subscription', (req, res) => {
    const c = need(req, res); if (!c) return;
    try {
      const r = lifecycle.saveSubscription(c.id, req.body || {}, req.padmin.email);
      const strip = a => a ? pick(a, ['plan', 'date_debut', 'date_fin', 'montant', 'periodicite', 'statut_paiement', 'notes', 'grace_jours']) : null;
      store.paudit(req.padmin, 'abonnement_modifie', { type: 'espace', id: c.id, libelle: c.slug, avant: strip(r.avant), apres: strip(r.apres) }, req);
      res.json({ ok: true, abonnement: lifecycle.subscriptionState(c.id) });
    } catch (e) { err(res, e); }
  });

  api.post('/workspaces/:id/suspend', (req, res) => {
    const c = need(req, res); if (!c) return;
    try {
      const r = lifecycle.suspend(c.id, (req.body || {}).motif, actorLabel(req), netu.clientIp(req));
      store.paudit(req.padmin, 'espace_suspendu', { type: 'espace', id: c.id, libelle: c.slug, avant: { statut: 'actif' }, apres: { statut: 'suspendu' }, details: { motif: req.body.motif, sessions_fermees: r.sessionsFermees } }, req);
      res.json({ ok: true, ...r });
    } catch (e) { err(res, e); }
  });
  api.post('/workspaces/:id/reactivate', (req, res) => {
    const c = need(req, res); if (!c) return;
    try {
      lifecycle.reactivate(c.id, (req.body || {}).motif, actorLabel(req), netu.clientIp(req));
      store.paudit(req.padmin, 'espace_reactive', { type: 'espace', id: c.id, libelle: c.slug, avant: { statut: 'suspendu' }, apres: { statut: 'actif' }, details: { motif: req.body.motif } }, req);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // Export (préalable obligatoire à la suppression) : fichier JSON écrit SUR LE SERVEUR, jamais renvoyé à la console.
  api.post('/workspaces/:id/export', (req, res) => {
    const c = need(req, res); if (!c) return;
    try {
      const r = lifecycle.exportWorkspace(c.id, req.padmin.email);
      store.paudit(req.padmin, 'espace_exporte', { type: 'espace', id: c.id, libelle: c.slug, details: { fichier: r.fichier, sha256: r.sha256, taille: r.taille, lignes: r.lignes } }, req);
      lifecycle.tenantAudit(c.id, 'export_espace', { fichier: r.fichier }, actorLabel(req), netu.clientIp(req));
      res.json({ ok: true, export: { id: r.id, fichier: r.fichier, chemin: r.chemin, sha256: r.sha256, taille: r.taille, lignes: r.lignes } });
    } catch (e) { err(res, e); }
  });
  api.post('/workspaces/:id/delete', (req, res) => {
    const c = need(req, res); if (!c) return;
    try {
      const r = lifecycle.softDelete(c.id, req.body || {}, actorLabel(req), netu.clientIp(req));
      store.paudit(req.padmin, 'espace_supprime', { type: 'espace', id: c.id, libelle: c.slug, avant: { statut: lifecycle.statusOf(c) }, apres: { statut: 'supprime', purge_possible_apres: r.purgeApres }, details: { motif: req.body.motif, export: r.export, sessions_fermees: r.sessionsFermees } }, req);
      res.json({ ok: true, ...r });
    } catch (e) { err(res, e); }
  });
  api.post('/workspaces/:id/restore', (req, res) => {
    const c = need(req, res); if (!c) return;
    try {
      lifecycle.restore(c.id, (req.body || {}).motif, actorLabel(req), netu.clientIp(req));
      store.paudit(req.padmin, 'espace_restaure', { type: 'espace', id: c.id, libelle: c.slug, avant: { statut: 'supprime' }, apres: { statut: 'suspendu' }, details: { motif: req.body.motif } }, req);
      res.json({ ok: true });
    } catch (e) { err(res, e); }
  });

  // Nouvelle invitation du premier administrateur (lien perdu ou expiré) — si l'espace n'a encore aucun administrateur actif.
  api.post('/workspaces/:id/admin-invitation', (req, res) => {
    const c = need(req, res); if (!c) return;
    if (c.supprime_le) return res.status(409).json({ error: 'Espace supprimé.', code: 'espace_supprime' });
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (workspace.activeAdminCount(c.id) > 0) return res.status(409).json({ error: 'Cet espace a déjà un administrateur actif : c’est lui qui invite les utilisateurs.', code: 'admin_existant' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
    const inv = workspace.insertInvitation(c.id, null, email, 'admin');
    lifecycle.tenantAudit(c.id, 'create', { email, role: 'admin', expire: inv.expires_at }, actorLabel(req), netu.clientIp(req));
    store.paudit(req.padmin, 'invitation_admin', { type: 'espace', id: c.id, libelle: c.slug, details: { email, expire: inv.expires_at } }, req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, invitation: { email, lien: `${workspaceOrigin(req, c.slug)}/invite#t=${inv.token}`, expire: inv.expires_at } });
  });

  // Bandeaux de maintenance : par espace et global (message + heure de fin facultative).
  api.put('/workspaces/:id/maintenance', (req, res) => {
    const c = need(req, res); if (!c) return;
    try {
      const m = lifecycle.validMaint(req.body || {});
      const avant = lifecycle.parseMaint(c.maintenance_json);
      db.prepare('UPDATE cabinet SET maintenance_json=? WHERE id=?').run(JSON.stringify(m), c.id);
      store.paudit(req.padmin, 'maintenance_espace', { type: 'espace', id: c.id, libelle: c.slug, avant, apres: m }, req);
      res.json({ ok: true, maintenance: m });
    } catch (e) { err(res, e); }
  });
  api.delete('/workspaces/:id/maintenance', (req, res) => {
    const c = need(req, res); if (!c) return;
    const avant = lifecycle.parseMaint(c.maintenance_json);
    db.prepare('UPDATE cabinet SET maintenance_json=NULL WHERE id=?').run(c.id);
    store.paudit(req.padmin, 'maintenance_espace', { type: 'espace', id: c.id, libelle: c.slug, avant, apres: null }, req);
    res.json({ ok: true });
  });
  api.get('/maintenance', (req, res) => res.json({ maintenance: lifecycle.activeMaint(store.getSetting('maintenance', null)) }));
  api.put('/maintenance', (req, res) => {
    try {
      const m = lifecycle.validMaint(req.body || {});
      const avant = store.getSetting('maintenance', null);
      store.setSetting('maintenance', m, req.padmin.email);
      store.paudit(req.padmin, 'maintenance_globale', { type: 'plateforme', libelle: 'tous les espaces', avant, apres: m }, req);
      res.json({ ok: true, maintenance: m });
    } catch (e) { err(res, e); }
  });
  api.delete('/maintenance', (req, res) => {
    const avant = store.getSetting('maintenance', null);
    store.setSetting('maintenance', null, req.padmin.email);
    store.paudit(req.padmin, 'maintenance_globale', { type: 'plateforme', libelle: 'tous les espaces', avant, apres: null }, req);
    res.json({ ok: true });
  });
};
module.exports.workspaceOrigin = workspaceOrigin;
