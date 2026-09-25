'use strict';
/**
 * Espaces de travail (tenant = cabinet) — création transactionnelle, statut, logo, onboarding,
 * invitations. Aucune règle métier 69-21 ici : identité, accès et administration uniquement.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, audit } = require('./db');
const { hashPassword } = require('./auth');
const { uid } = require('./util');
const tenant = require('./tenant');
const permissions = require('./permissions');

const LOGO_DIR = path.join(__dirname, '..', 'uploads', 'logos');
const LOGO_MAX = 1024 * 1024; // 1 Mo
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 10;
const INVITE_TTL_DAYS = 7;
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'static', 'assets', 'mail', 'status', 'demo', 'login', 'support']);

class WorkspaceError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères.`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Le mot de passe doit contenir au moins une lettre et un chiffre.';
  return null;
}
function initialsOfName(nom) { return (String(nom || 'U').trim().split(/\s+/).map(x => x[0]).join('').slice(0, 2) || 'U').toUpperCase(); }

/**
 * Crée un espace ET son premier administrateur dans UNE transaction (jamais d'espace partiel).
 * @returns {{ cabinetId, userId, slug }}
 */
function createWorkspace(input) {
  const i = input || {};
  const slug = String(i.slug || '').trim().toLowerCase();
  if (!tenant.SLUG_RE.test(slug) || RESERVED.has(slug)) throw new WorkspaceError('Identifiant d’espace invalide : 2 à 40 caractères, lettres minuscules, chiffres et tirets (ex. « premium »).');
  const nom = String(i.nom || '').trim();
  if (!nom || nom.length > 120) throw new WorkspaceError('Nom du cabinet requis (120 caractères maximum).');
  const a = i.admin || {};
  const email = String(a.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new WorkspaceError('Adresse e-mail de l’administrateur invalide.');
  const adminNom = String(a.nom || '').trim();
  if (!adminNom) throw new WorkspaceError('Nom de l’administrateur requis.');
  const pwErr = passwordProblem(a.password); if (pwErr) throw new WorkspaceError(pwErr);
  const patch = tenant.validateWorkspacePatch({
    nomAffiche: i.nomAffiche, raisonLegale: i.raisonLegale, primaryColor: i.primaryColor, locale: i.locale,
    devise: i.devise, fuseauHoraire: i.fuseauHoraire, contactEmail: i.contactEmail, contactTelephone: i.contactTelephone, adresse: i.adresse,
  }, { allowEmpty: true });
  if (!patch.ok) throw new WorkspaceError(patch.error);
  if (db.prepare('SELECT 1 FROM cabinet WHERE lower(slug)=?').get(slug)) throw new WorkspaceError(`L’identifiant « ${slug} » est déjà utilisé.`, 409);

  const cabinetId = uid('cab'), userId = uid('usr');
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO cabinet (id, nom, slug, plan, actif, updated_at) VALUES (?,?,?,?,1,datetime('now'))`)
      .run(cabinetId, nom, slug, i.plan || 'pro');
    const cols = Object.keys(patch.values);
    if (cols.length) db.prepare(`UPDATE cabinet SET ${cols.map(c => c + '=?').join(', ')} WHERE id=?`).run(...cols.map(c => patch.values[c]), cabinetId);
    db.prepare(`INSERT INTO utilisateur (id, cabinet_id, nom, email, password_hash, role, initiales, titre, actif)
                VALUES (?,?,?,?,?,'admin',?,?,1)`).run(userId, cabinetId, adminNom, email, hashPassword(a.password), initialsOfName(adminNom), a.titre || 'Administrateur');
    if (typeof i.onInsideTransaction === 'function') i.onInsideTransaction(); // (tests) injection d'échec
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(cabinetId, userId, 'create', 'espace_travail', { slug, nom, admin: email }, null);
  return { cabinetId, userId, slug };
}

function setWorkspaceActive(cabinetId, actif) {
  db.prepare(`UPDATE cabinet SET actif=?, updated_at=datetime('now') WHERE id=?`).run(actif ? 1 : 0, cabinetId);
  audit(cabinetId, null, actif ? 'activation' : 'desactivation', 'espace_travail', { actif: !!actif }, null);
}

/* ---------------- Logo : PNG / JPEG / WebP uniquement (octets d'en-tête), SVG refusé ---------------- */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null; // SVG, GIF, HTML déguisé… refusés
}
/** Enregistre le logo (nom de fichier généré, jamais celui du client). */
function saveLogo(cabinetId, filePath, size) {
  if (!filePath) throw new WorkspaceError('Aucun fichier reçu.');
  try {
    if (size > LOGO_MAX) throw new WorkspaceError('Logo trop volumineux : 1 Mo maximum.');
    const fd = fs.openSync(filePath, 'r'); const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); fs.closeSync(fd);
    const kind = sniffImage(head);
    if (!kind) throw new WorkspaceError('Format non accepté : PNG, JPEG ou WebP uniquement (le SVG est refusé pour des raisons de sécurité).');
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    const name = `logo_${crypto.randomBytes(12).toString('hex')}.${kind.ext}`;
    fs.renameSync(filePath, path.join(LOGO_DIR, name));
    const old = db.prepare('SELECT logo FROM cabinet WHERE id=?').get(cabinetId);
    db.prepare(`UPDATE cabinet SET logo=?, logo_mime=?, updated_at=datetime('now') WHERE id=?`).run(name, kind.mime, cabinetId);
    if (old && old.logo && /^logo_[a-f0-9]+\.(png|jpg|webp)$/.test(old.logo)) { try { fs.unlinkSync(path.join(LOGO_DIR, old.logo)); } catch (_) {} }
    return { logo: name, mime: kind.mime };
  } finally { try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {} }
}
function removeLogo(cabinetId) {
  const old = db.prepare('SELECT logo FROM cabinet WHERE id=?').get(cabinetId);
  db.prepare(`UPDATE cabinet SET logo=NULL, logo_mime=NULL, updated_at=datetime('now') WHERE id=?`).run(cabinetId);
  if (old && old.logo && /^logo_[a-f0-9]+\.(png|jpg|webp)$/.test(old.logo)) { try { fs.unlinkSync(path.join(LOGO_DIR, old.logo)); } catch (_) {} }
}
/** Chemin sûr du logo d'un cabinet (ou null). */
function logoFile(cab) {
  if (!cab || !cab.logo || !/^logo_[a-f0-9]+\.(png|jpg|webp)$/.test(cab.logo)) return null;
  const p = path.join(LOGO_DIR, cab.logo);
  return fs.existsSync(p) ? { path: p, mime: cab.logo_mime || 'image/png' } : null;
}

/* ---------------- Onboarding : étapes, achèvement DÉTECTÉ sur données réelles ---------------- */
const ONBOARDING_STEPS = [
  { key: 'bienvenue', label: 'Bienvenue dans DelaiPay', optional: false },
  { key: 'cabinet', label: 'Configurez votre cabinet', optional: false },
  { key: 'client', label: 'Créez votre premier dossier client', optional: false },
  // La période PRÉCÈDE l'import : les factures sont rattachées au trimestre choisi (jamais au trimestre par défaut).
  { key: 'periode', label: 'Choisissez le trimestre à traiter', optional: false },
  { key: 'factures', label: 'Importez vos factures (journal TVA)', optional: false },
  { key: 'conventions', label: 'Ajoutez vos conventions', optional: true },
  { key: 'reseau', label: 'Vérifiez les opérateurs réseau', optional: true },
  { key: 'pret', label: 'Vous êtes prêt', optional: false },
];
function onboardingFacts(cabinetId) {
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(cabinetId) || {};
  const n = sql => db.prepare(sql).get(cabinetId).n;
  return {
    cabinetConfigure: !!(cab.raison_legale || cab.nom_affiche || cab.logo || cab.contact_email),
    clients: n('SELECT COUNT(*) n FROM entreprise WHERE cabinet_id=?'),
    factures: n('SELECT COUNT(*) n FROM facture WHERE cabinet_id=?'),
    conventions: n('SELECT COUNT(*) n FROM convention WHERE cabinet_id=?'),
    reseauPropose: n(`SELECT COUNT(*) n FROM fournisseur WHERE cabinet_id=? AND statut_classification='propose'`),
    reseauConfirme: n(`SELECT COUNT(*) n FROM fournisseur WHERE cabinet_id=? AND operateur_reseau=1 AND statut_classification='confirme'`),
    utilisateurs: n('SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=? AND actif=1'),
  };
}
function onboardingState(cabinetId) {
  const cab = db.prepare('SELECT onboarding_json FROM cabinet WHERE id=?').get(cabinetId) || {};
  let saved = {}; try { saved = JSON.parse(cab.onboarding_json || '{}') || {}; } catch (_) {}
  const f = onboardingFacts(cabinetId);
  const auto = {
    // P3-12 : « Bienvenue » est terminée dès que l'utilisateur est passé à une autre étape (ou qu'un client existe).
    bienvenue: (!!saved.current && saved.current !== 'bienvenue') || f.clients > 0,
    cabinet: f.cabinetConfigure, client: f.clients > 0, factures: f.factures > 0, conventions: f.conventions > 0,
    reseau: f.factures > 0 && f.reseauPropose === 0,
  };
  const done = Object.assign({}, saved.done || {});
  const steps = ONBOARDING_STEPS.map(s => ({ ...s,
    status: (auto[s.key] || done[s.key] === 'done') ? 'done' : (done[s.key] === 'skipped' ? 'skipped' : 'todo'),
    auto: !!auto[s.key] }));
  const required = steps.filter(s => !s.optional && !['bienvenue', 'pret'].includes(s.key));
  const complete = !!saved.completedAt;
  const progress = Math.round(100 * steps.filter(s => s.status !== 'todo' && s.key !== 'pret').length / (steps.length - 1));
  // Parcours réellement entamé par l'équipe (étape visitée, validée ou trimestre choisi) — distingue un espace neuf
  // d'un espace déjà exploité avant l'existence de l'onboarding (P3-1).
  const started = !!(saved.current || saved.periode || Object.keys(saved.done || {}).length);
  return { steps, facts: f, periode: saved.periode || null, current: saved.current || 'bienvenue', dismissed: !!saved.dismissed, completedAt: saved.completedAt || null, started,
    complete, readyToFinish: required.every(s => s.status === 'done'), progress };
}
function updateOnboarding(cabinetId, userId, patch) {
  const cab = db.prepare('SELECT onboarding_json FROM cabinet WHERE id=?').get(cabinetId) || {};
  let s = {}; try { s = JSON.parse(cab.onboarding_json || '{}') || {}; } catch (_) {}
  s.done = s.done || {};
  const keys = new Set(ONBOARDING_STEPS.map(x => x.key));
  if (patch.current && keys.has(patch.current)) s.current = patch.current;
  if (patch.step && keys.has(patch.step) && ['done', 'skipped', 'todo'].includes(patch.status)) {
    const step = ONBOARDING_STEPS.find(x => x.key === patch.step);
    if (patch.status === 'skipped' && !step.optional) throw new WorkspaceError('Cette étape est indispensable et ne peut pas être ignorée.');
    if (patch.status === 'todo') delete s.done[patch.step]; else s.done[patch.step] = patch.status;
  }
  if (patch.periode !== undefined) {
    const a = +(patch.periode && patch.periode.annee), t = +(patch.periode && patch.periode.trimestre);
    if (!(Number.isInteger(a) && a >= 2000 && a <= 2100 && [1, 2, 3, 4].includes(t))) throw new WorkspaceError('Trimestre invalide.');
    s.periode = { annee: a, trimestre: t }; s.done.periode = 'done';
  }
  if (patch.step === 'periode' && patch.status === 'done' && !s.periode) throw new WorkspaceError('Choisissez un trimestre.');
  if (patch.dismissed != null) s.dismissed = !!patch.dismissed;
  if (patch.complete) {
    const st = onboardingState(cabinetId);
    if (!st.readyToFinish) throw new WorkspaceError('Terminez d’abord les étapes indispensables (cabinet, client, factures, période).');
    s.completedAt = new Date().toISOString(); s.dismissed = true;
    audit(cabinetId, userId, 'onboarding_termine', 'espace_travail', {}, null);
  }
  db.prepare(`UPDATE cabinet SET onboarding_json=?, updated_at=datetime('now') WHERE id=?`).run(JSON.stringify(s), cabinetId);
  return onboardingState(cabinetId);
}

/* ---------------- Utilisateurs ---------------- */
function listUsers(cabinetId) {
  return db.prepare(`SELECT id, nom, email, role, titre, actif, created_at, derniere_connexion FROM utilisateur WHERE cabinet_id=? ORDER BY actif DESC, nom`).all(cabinetId)
    .map(u => ({ ...u, actif: !!u.actif, roleLabel: (permissions.ROLES[u.role] || {}).label || u.role }));
}
function activeAdminCount(cabinetId) { return db.prepare(`SELECT COUNT(*) n FROM utilisateur WHERE cabinet_id=? AND role='admin' AND actif=1`).get(cabinetId).n; }
/** Modifie rôle / statut d'un utilisateur DU MÊME cabinet. Protège le dernier administrateur et soi-même. */
function updateUser(cabinetId, actorId, targetId, patch) {
  const u = db.prepare('SELECT * FROM utilisateur WHERE id=? AND cabinet_id=?').get(targetId, cabinetId);
  if (!u) throw new WorkspaceError('Utilisateur introuvable.', 404);
  const next = { role: u.role, actif: u.actif };
  if (patch.role !== undefined) { if (!permissions.isRole(patch.role)) throw new WorkspaceError('Rôle inconnu.'); next.role = patch.role; }
  if (patch.actif !== undefined) next.actif = patch.actif ? 1 : 0;
  if (targetId === actorId && (next.role !== 'admin' || !next.actif)) throw new WorkspaceError('Vous ne pouvez pas retirer vos propres droits d’administration ni désactiver votre propre compte.');
  const losingAdmin = u.role === 'admin' && u.actif && (next.role !== 'admin' || !next.actif);
  if (losingAdmin && activeAdminCount(cabinetId) <= 1) throw new WorkspaceError('L’espace doit conserver au moins un administrateur actif.');
  // Une ancienne « fonction » qui n'était que le libellé d'un rôle est effacée (jamais de rôle périmé affiché).
  const staleTitre = u.titre && Object.values(permissions.ROLES).some(r => r.label === u.titre);
  db.prepare('UPDATE utilisateur SET role=?, actif=?, titre=? WHERE id=?').run(next.role, next.actif, staleTitre ? null : u.titre, u.id);
  audit(cabinetId, actorId, 'update', 'utilisateur', { utilisateur: u.email, avant: { role: u.role, actif: !!u.actif }, apres: { role: next.role, actif: !!next.actif } }, null);
  return listUsers(cabinetId).find(x => x.id === u.id);
}

/* ---------------- Invitations (locales, prêtes pour l'e-mail) ---------------- */
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function createInvitation(cabinetId, actorId, { email, role }) {
  const mail = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(mail)) throw new WorkspaceError('Adresse e-mail invalide.');
  if (!permissions.isRole(role)) throw new WorkspaceError('Rôle inconnu.');
  if (db.prepare('SELECT 1 FROM utilisateur WHERE cabinet_id=? AND email=?').get(cabinetId, mail)) throw new WorkspaceError('Un utilisateur de cet espace possède déjà cette adresse.', 409);
  db.prepare(`UPDATE invitation SET revoked_at=datetime('now') WHERE cabinet_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(cabinetId, mail);
  const token = crypto.randomBytes(32).toString('base64url');
  const id = uid('inv');
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`INSERT INTO invitation (id, cabinet_id, email, role, token_hash, expires_at, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(id, cabinetId, mail, role, sha256(token), expires, actorId);
  audit(cabinetId, actorId, 'create', 'invitation', { email: mail, role, expire: expires }, null); // jamais le jeton
  return { id, email: mail, role, expires_at: expires, token }; // le jeton n'est renvoyé qu'ici, une seule fois
}
function listInvitations(cabinetId) {
  return db.prepare(`SELECT i.id, i.email, i.role, i.expires_at, i.created_at, i.accepted_at, i.revoked_at, u.nom created_by_nom
      FROM invitation i LEFT JOIN utilisateur u ON u.id=i.created_by WHERE i.cabinet_id=? ORDER BY i.created_at DESC LIMIT 100`).all(cabinetId)
    .map(i => ({ ...i, statut: i.accepted_at ? 'acceptee' : i.revoked_at ? 'revoquee' : (i.expires_at < nowSql() ? 'expiree' : 'en_attente') }));
}
function revokeInvitation(cabinetId, actorId, id) {
  const r = db.prepare(`UPDATE invitation SET revoked_at=datetime('now') WHERE id=? AND cabinet_id=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(id, cabinetId);
  if (!r.changes) throw new WorkspaceError('Invitation introuvable ou déjà utilisée.', 404);
  audit(cabinetId, actorId, 'revocation', 'invitation', { id }, null);
}
function nowSql() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
/** Invitation valide pour ce jeton (et, si l'hôte désigne un espace, pour CET espace). */
function findValidInvitation(token, hostCabinetId) {
  if (!token || String(token).length < 20) return null;
  const inv = db.prepare('SELECT * FROM invitation WHERE token_hash=?').get(sha256(token));
  if (!inv || inv.accepted_at || inv.revoked_at || inv.expires_at < nowSql()) return null;
  if (hostCabinetId !== undefined && hostCabinetId !== null && inv.cabinet_id !== hostCabinetId) return null;
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(inv.cabinet_id);
  if (!cab || cab.actif === 0) return null;
  return { inv, cab };
}
function acceptInvitation(token, hostCabinetId, { nom, password }) {
  const found = findValidInvitation(token, hostCabinetId);
  if (!found) throw new WorkspaceError('Cette invitation est invalide, expirée ou déjà utilisée.', 410);
  const n = String(nom || '').trim(); if (!n || n.length > 80) throw new WorkspaceError('Indiquez votre nom (80 caractères maximum).');
  const pwErr = passwordProblem(password); if (pwErr) throw new WorkspaceError(pwErr);
  const { inv } = found;
  if (db.prepare('SELECT 1 FROM utilisateur WHERE cabinet_id=? AND email=?').get(inv.cabinet_id, inv.email)) throw new WorkspaceError('Un compte existe déjà pour cette adresse dans cet espace.', 409);
  const userId = uid('usr');
  db.exec('BEGIN');
  try {
    const upd = db.prepare(`UPDATE invitation SET accepted_at=datetime('now'), accepted_user_id=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL`).run(userId, inv.id);
    if (!upd.changes) throw new WorkspaceError('Cette invitation vient d’être utilisée.', 410);
    db.prepare(`INSERT INTO utilisateur (id, cabinet_id, nom, email, password_hash, role, initiales, titre, actif, invite_par)
                VALUES (?,?,?,?,?,?,?,?,1,?)`).run(userId, inv.cabinet_id, n, inv.email, hashPassword(password), inv.role, initialsOfName(n), null, inv.created_by);
    // (la « fonction » n'est plus déduite du rôle : le rôle effectif est toujours lu en base)
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  audit(inv.cabinet_id, userId, 'acceptation', 'invitation', { email: inv.email, role: inv.role }, null);
  return db.prepare('SELECT * FROM utilisateur WHERE id=?').get(userId);
}

module.exports = {
  WorkspaceError, createWorkspace, setWorkspaceActive, saveLogo, removeLogo, logoFile, sniffImage,
  ONBOARDING_STEPS, onboardingState, updateOnboarding, listUsers, updateUser, activeAdminCount,
  createInvitation, listInvitations, revokeInvitation, findValidInvitation, acceptInvitation, passwordProblem, RESERVED,
};
