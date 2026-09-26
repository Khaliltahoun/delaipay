'use strict';
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { db, tauxAt, audit, activeConventionFor } = require('./db');
const calc = require('./calc');
const periode = require('./periode');
const { importWorkbook } = require('./importer');
const reseau = require('./reseau');
const periodCheck = require('./period-check');
const anomalies = require('./anomalies');
const auth = require('./auth');
const visa = require('./visa');
const tenant = require('./tenant');
const workspace = require('./workspace');
const permissions = require('./permissions');
const { rateLimit } = require('./security');
const { uid, normalizeIce, fmtMoney, slugify } = require('./util');

// Anti force brute, à DEUX niveaux :
//  - par identité ciblée (IP + espace de l'hôte + e-mail) : 10 échecs / 15 min — un collaborateur qui se trompe
//    ne bloque ni ses collègues derrière la même IP, ni un autre espace ; remis à zéro après une connexion réussie ;
//  - plafond global par IP (100 / 15 min) : limite la pulvérisation de mots de passe sur de nombreux comptes.
const loginKey = req => `${req.ip}|${require('./tenant').slugFromHost(req.hostname || req.headers.host || '') || '-'}|${String((req.body && req.body.email) || '').toLowerCase().trim()}`;
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: loginKey, code: 'account_locked',
  message: 'Ce compte est temporairement verrouillé après plusieurs mots de passe incorrects. Réessayez dans 15 minutes, ou demandez à l’administrateur de votre espace de vérifier votre accès.',
  onLimit: req => auditLogin(req, 'verrouillage_connexion', 'compte verrouillé 15 min après 10 échecs') });
const loginIpCeiling = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, code: 'network_locked',
  message: 'Trop de tentatives de connexion depuis votre réseau, tous comptes confondus. Réessayez dans 15 minutes.',
  onLimit: req => auditLogin(req, 'verrouillage_connexion', 'plafond du réseau atteint (100 tentatives / 15 min)') });

// Journal des connexions refusées et des verrouillages (NEW-5) : écrit dans l'espace VISÉ (hôte, ou espaces
// où l'e-mail existe) — e-mail et motif uniquement, jamais le mot de passe saisi.
function auditLogin(req, action, motif, cabinetIds) {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim().slice(0, 254);
  let cabs = cabinetIds;
  if (!cabs) {
    const ws = tenant.resolve(req);
    cabs = ws.slug ? (ws.cabinet ? [ws.cabinet.id] : [])
      : db.prepare('SELECT DISTINCT cabinet_id FROM utilisateur WHERE email=?').all(email).map(r => r.cabinet_id);
  }
  for (const c of (cabs.length ? cabs : [null])) audit(c, null, action, 'utilisateur', { email: email || null, motif }, req.ip);
}

// Limiteur pour les routes coûteuses (import de gros classeurs, exports) :
// le parsing/génération est synchrone et bloque la boucle d'événements — on
// empêche un utilisateur de saturer le processus partagé par tous les cabinets.
const heavyLimiter = rateLimit({ windowMs: 60 * 1000, max: 20,
  message: 'Trop de requêtes. Patientez quelques secondes.' });

// Express 4 ne capture pas les rejets de promesses des handlers async : on les
// relaie explicitement au middleware d'erreur (sinon la requête reste suspendue).
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UP_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UP_DIR, { recursive: true });
const upload = multer({ dest: UP_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

// Supprime les fichiers temporaires écrits par multer si le handler s'arrête tôt
// (évite d'accumuler des fichiers orphelins → saturation disque).
function cleanupUploads(req) {
  const files = req.files || (req.file ? [req.file] : []);
  for (const f of files) { if (f && f.path) try { fs.unlinkSync(f.path); } catch (_) {} }
}


/* Messages « introuvable » en clair : ce qui s'est passé + que faire. Le code permet à l'interface de réagir
 * (ex. dossier supprimé par un collègue → sélection effacée, retour à la liste des clients). */
const NOT_FOUND = {
  client: 'Ce dossier client n’existe plus ou n’est pas accessible depuis votre espace (il a peut-être été supprimé par un collègue). Choisissez un client dans la liste « Clients ».',
  convention: 'Cette convention n’existe plus (elle a peut-être été supprimée entre-temps). Actualisez la liste des conventions.',
  fournisseur: 'Ce fournisseur n’existe plus dans ce dossier. Actualisez la page pour voir la liste à jour.',
  facture: 'Cette facture n’existe plus (son import a peut-être été annulé). Actualisez la feuille des délais.',
  import: 'Cet import n’existe plus (il a peut-être été annulé). Consultez l’historique des imports du dossier.',
  modele: 'Ce modèle de correspondance n’existe plus. Choisissez-en un autre ou enregistrez-le à nouveau.',
  fichier: 'Ce fichier n’est plus disponible (il a peut-être été supprimé). Actualisez la liste des fichiers.',
};
/* Anomalies : statuts et compteurs = SOURCE UNIQUE src/anomalies.js (INC 2.1). */
function notFound(res, what) { return res.status(404).json({ error: NOT_FOUND[what], code: what + '_introuvable' }); }
// Téléchargements (réponse texte) : même message, sans JSON.
function notFoundText(res, what) { return res.status(404).type('text/plain; charset=utf-8').send(NOT_FOUND[what]); }

const router = express.Router();

/* ============================================================ helpers */
function assujettie(ca) { return Number(ca) > 2_000_000; }
function regimeOf(ca, annee) {
  if (!assujettie(ca)) return '—';
  if (annee >= 2026) return 'Trimestriel';
  if (ca > 50_000_000) return 'Trimestriel';
  return 'Annuel';
}
function visaOf(ca) { return ca >= 50_000_000 ? 'CAC' : 'EC'; }
function ownedEntreprise(req, id) {
  const e = db.prepare('SELECT * FROM entreprise WHERE id=? AND cabinet_id=?').get(id, req.cabinetId);
  return e || null;
}

/* ---------------------------------------------------------------- contexte PÉRIODE (validé serveur) */
// Récupère (annee, trimestre) depuis params d'URL ou query ; null si absents.
function readPeriodParams(req) {
  const a = req.params.annee ?? req.query.annee;
  const t = req.params.trimestre ?? req.query.trimestre;
  if (a == null || t == null || a === '' || t === '') return null;
  return { annee: +a, trimestre: +t };
}
// Exige une période valide, sinon renvoie null après avoir répondu 400.
function requirePeriod(req, res) {
  const p = readPeriodParams(req);
  if (!p || !periode.isValidPeriod(p.annee, p.trimestre)) {
    res.status(400).json({ error: 'Période (année + trimestre) requise et valide.' });
    return null;
  }
  return p;
}
// EXPORTS (LOT 7 — Phase 3) : la période est OBLIGATOIRE et validée, jamais devinée. Sans ce garde-fou
// un export sans paramètre retombait silencieusement sur `latestPeriod` (« la plus fournie ») et une
// période illisible produisait un livrable « declaration_NaN_T9.csv ». Un fichier remis à la DGI ne
// doit jamais porter une période implicite. Réponse en texte brut : ces routes servent des fichiers.
function requireExportPeriod(req, res) {
  const p = readPeriodParams(req);
  if (!p || !periode.isValidPeriod(p.annee, p.trimestre)) {
    res.status(400).type('text/plain; charset=utf-8')
      .send('Export impossible : période (année + trimestre) requise et valide — ex. ?annee=2026&trimestre=1.');
    return null;
  }
  return p;
}
// Journalisation UNIFORME de tout export (LOT 7 — Phase 8) : qui, quand (`created_at`), quel cabinet,
// quel client, quelle période, quel format, quel volume. Un livrable remis à la DGI doit être traçable.
function auditExport(req, entite, format, e, p, extra) {
  audit(req.cabinetId, req.user.id, 'export', entite, {
    format, entreprise: e ? e.id : null, client: e ? e.raison_sociale : null,
    annee: p ? p.annee : null, trimestre: p ? p.trimestre : null, ...(extra || {}),
  }, req.ip);
}
// Retourne la ligne periode_declaration, en la CRÉANT paresseusement (défauts calendaires) si absente.
function ensurePeriode(cabinetId, entrepriseId, annee, trimestre) {
  let row = db.prepare('SELECT * FROM periode_declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(entrepriseId, annee, trimestre);
  if (row) return row;
  const info = periode.periodInfo(annee, trimestre);
  const id = uid('per');
  db.prepare(`INSERT INTO periode_declaration
    (id, cabinet_id, entreprise_id, annee, trimestre, date_debut, date_fin, mois_traitement, annee_traitement, statut)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, cabinetId, entrepriseId, annee, trimestre, info.date_debut, info.date_fin, info.mois_traitement, info.annee_traitement, periode.defaultStatut(annee, trimestre));
  return db.prepare('SELECT * FROM periode_declaration WHERE id=?').get(id);
}
// Vérifie qu'une période est modifiable ; sinon répond 423 (verrouillée) et renvoie false.
function assertWritable(res, cabinetId, entrepriseId, annee, trimestre) {
  const row = ensurePeriode(cabinetId, entrepriseId, annee, trimestre);
  if (periode.isLocked(row.statut)) {
    res.status(423).json({ error: `Période ${periode.periodInfo(annee, trimestre).label} clôturée (${periode.STATUT_LABELS[row.statut]}). Données en lecture seule.`, statut: row.statut });
    return false;
  }
  return true;
}
// Liste enrichie des périodes d'une entreprise (réelles + navigation + statut + compteurs).
function buildPeriodsList(cabinetId, entrepriseId) {
  const rows = db.prepare(`SELECT annee, trimestre, COUNT(*) n FROM facture
    WHERE entreprise_id=? AND annee IS NOT NULL GROUP BY annee, trimestre
    ORDER BY annee DESC, trimestre DESC`).all(entrepriseId);
  const disponibles = rows.map(r => {
    const info = periode.periodInfo(r.annee, r.trimestre);
    const pr = ensurePeriode(cabinetId, entrepriseId, r.annee, r.trimestre);
    return { annee: r.annee, trimestre: r.trimestre, label: info.label, nbFactures: r.n, statut: pr.statut,
             statutLabel: periode.STATUT_LABELS[pr.statut], verrouillee: periode.isLocked(pr.statut),
             mois_traitement: info.mois_traitement, annee_traitement: info.annee_traitement };
  });
  const travail = periode.workingPeriod();
  const plusFournie = rows.length ? (() => { let best = rows[0]; for (const r of rows) if (r.n > best.n) best = r; return { annee: best.annee, trimestre: best.trimestre }; })() : null;
  return { disponibles, travail, plusFournie, actuelle: travail };
}
function latestPeriod(entrepriseId) {
  // Période par défaut = celle qui contient le PLUS de factures (représentative),
  // et non la plus récente : évite qu'une facture isolée mal datée (ex. 2031) vide la vue.
  const r = db.prepare(`SELECT annee, trimestre, COUNT(*) n FROM facture WHERE entreprise_id=? AND annee IS NOT NULL
                        GROUP BY annee, trimestre ORDER BY n DESC, annee DESC, trimestre DESC LIMIT 1`).get(entrepriseId);
  if (r) return { annee: r.annee, trimestre: r.trimestre };
  const d = new Date(); return { annee: d.getFullYear(), trimestre: Math.floor(d.getMonth() / 3) + 1 };
}
function recomputePeriod(cabinetId, entrepriseId, annee, trimestre) {
  // IMMUABILITÉ (LOT 6) : une période clôturée / déclarée est FIGÉE. Aucun recalcul ne réécrit ses
  // factures — même déclenché par une consultation (/summary, déclaration) après un changement de
  // convention/réseau. Les valeurs restent celles arrêtées à la clôture. Point de passage UNIQUE.
  const pr = db.prepare('SELECT statut FROM periode_declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(entrepriseId, annee, trimestre);
  if (pr && periode.isLocked(pr.statut)) return;
  const rows = db.prepare('SELECT * FROM facture WHERE entreprise_id=? AND annee=? AND trimestre=?')
    .all(entrepriseId, annee, trimestre);
  const upd = db.prepare(`UPDATE facture SET delai_applicable=?, delai_ecoule=?, date_limite=?,
    retard_jours=?, n_mois=?, a_declarer=?, taux_bam=?, taux_total=?, base_amende=?, montant_amende=?, couleur_risque=? WHERE id=?`);
  for (const f of rows) {
    const conv = activeConventionFor(entrepriseId, f.fournisseur_id);
    const fRow = db.prepare('SELECT * FROM fournisseur WHERE id=?').get(f.fournisseur_id);
    // Délai AUTORISÉ résolu centralement (opérateur réseau 30 j → convention → standard 60 j), borné [1,120].
    const delai = reseau.resolveDelaiAutorise({ fournisseur: fRow, convention: conv }).delaiAutorise;
    const c = calc.computeFacture({ dateFacture: f.date_facture, datePaiement: f.date_paiement, ttc: f.ttc,
      delaiApplicable: delai, periode: { annee, trimestre }, tauxProvider: (y, m) => tauxAt(y, m, cabinetId) });
    upd.run(delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
      c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque, f.id);
  }
}
// Recalcule TOUTES les périodes NON clôturées où les fournisseurs donnés ont des factures.
// Les périodes verrouillées (clôturées / déclarées) ne sont JAMAIS modifiées (OBJ 4).
function recomputeOpenPeriodsForFournisseurs(cabinetId, entrepriseId, fournisseurIds) {
  const ids = [...new Set((fournisseurIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  const q = db.prepare('SELECT DISTINCT annee, trimestre FROM facture WHERE entreprise_id=? AND fournisseur_id=? AND annee IS NOT NULL AND trimestre IS NOT NULL');
  const seen = new Set(); let n = 0;
  for (const fid of ids) {
    for (const p of q.all(entrepriseId, fid)) {
      const key = p.annee + '-' + p.trimestre;
      if (seen.has(key)) continue; seen.add(key);
      const row = ensurePeriode(cabinetId, entrepriseId, p.annee, p.trimestre);
      if (!periode.isLocked(row.statut)) { recomputePeriod(cabinetId, entrepriseId, p.annee, p.trimestre); n++; }
    }
  }
  return n;
}

/* ============================================================ AUTH */
router.post('/auth/login', loginIpCeiling, loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
  // Espace de travail désigné par le nom d'hôte (premium.delaipay.local…) : la recherche du compte est
  // limitée à CE cabinet. Hôte neutre (localhost, domaine actuel) : comportement historique inchangé.
  const ws = tenant.resolve(req);
  const mail = String(email).toLowerCase().trim();
  // Hôte neutre : le même e-mail peut exister dans PLUSIEURS espaces (UNIQUE cabinet+email) → jamais de
  // choix implicite (on ouvrirait peut-être le mauvais espace) : l'utilisateur doit passer par l'adresse de son espace.
  const candidates = ws.slug
    ? (ws.cabinet ? db.prepare('SELECT * FROM utilisateur WHERE email=? AND actif=1 AND cabinet_id=?').all(mail, ws.cabinet.id) : [])
    : db.prepare('SELECT * FROM utilisateur WHERE email=? AND actif=1').all(mail);
  // Le mot de passe est comparé à CHAQUE compte candidat (jamais au seul « premier trouvé ») ;
  // hash factice si aucun compte, pour ne pas révéler l'existence d'un compte par le temps de réponse.
  const matches = candidates.length ? candidates.filter(c => auth.verifyPassword(password, c.password_hash)) : (auth.verifyPassword(password, auth.DUMMY_HASH), []);
  if (!matches.length) {
    auditLogin(req, 'connexion_refusee', candidates.length ? 'mot de passe incorrect' : 'aucun compte actif pour cette adresse',
      candidates.length ? [...new Set(candidates.map(c => c.cabinet_id))] : undefined);
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }
  const u = matches[0];
  // Hôte neutre + e-mail présent dans plusieurs espaces : aucune sélection implicite, quel que soit
  // le compte dont le mot de passe correspond (même réponse pour tous — pas d'indication de l'espace).
  if (candidates.length > 1)
    return res.status(409).json({ error: 'Cette adresse e-mail est rattachée à plusieurs espaces de travail. Connectez-vous depuis l’adresse de votre espace (ex. votre-cabinet.delaipay.com).', code: 'ambiguous_workspace' });
  const ucab = db.prepare('SELECT actif FROM cabinet WHERE id=?').get(u.cabinet_id);
  if (!ucab || ucab.actif === 0) {
    auditLogin(req, 'connexion_refusee', 'espace de travail désactivé', [u.cabinet_id]);
    return res.status(403).json({ error: 'Cet espace de travail est désactivé. Contactez DelaiPay pour le réactiver.', code: 'workspace_inactive' });
  }
  try { db.prepare(`UPDATE utilisateur SET derniere_connexion=datetime('now') WHERE id=?`).run(u.id); } catch (_) {}
  loginLimiter.reset(req);   // connexion réussie : le compteur de CETTE identité repart de zéro
  const token = auth.signToken(u);
  auth.setAuthCookie(res, token);
  audit(u.cabinet_id, u.id, 'login', 'utilisateur', { email: u.email }, req.ip);
  res.json({ ok: true, user: publicUser(u) });
});
router.post('/auth/logout', (req, res) => { auth.clearAuthCookie(res); res.json({ ok: true }); });

router.get('/me', auth.requireAuth, (req, res) => {
  res.setHeader('X-DP-Session', `${req.user.id}:${req.user.role}`);
  const row = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.cabinetId);
  const cab = row ? { id: row.id, nom: row.nom, slug: row.slug, plan: row.plan } : null;
  const role = req.user.role;
  const perms = {}; for (const a of Object.keys(permissions.MATRIX)) perms[a] = permissions.can(role, a);
  res.json({ user: { ...publicUser(req.user), roleLabel: (permissions.ROLES[role] || {}).label || role }, cabinet: cab,
    workspace: tenant.workspaceOf(row), permissions: perms });
});

// Identité PUBLIQUE de l'espace désigné par le nom d'hôte (page de connexion) : nom affiché,
// initiales, couleurs. Aucune donnée interne (ni identifiant, ni contact, ni volumétrie).
// Logo PUBLIC de l'espace désigné par l'hôte (page de connexion). Type imposé, jamais de SVG.
router.get('/tenant/logo', (req, res) => {
  const ws = tenant.resolve(req);
  const f = ws.cabinet && ws.cabinet.actif !== 0 ? workspace.logoFile(ws.cabinet) : null;
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.mime); res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(f.path);
});
// Invitations — routes PUBLIQUES (le jeton fait foi ; si l'hôte désigne un espace, il doit correspondre).
const inviteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
function hostCabinetId(req) {
  const ws = tenant.resolve(req);
  if (!ws.slug) return undefined;              // hôte neutre : pas de contrainte d'hôte
  return ws.cabinet ? ws.cabinet.id : '__inconnu__';
}
// POST (et non GET) : le jeton ne transite jamais dans une URL (journaux, historique, Referer).
router.post('/invitations/lookup', inviteLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const f = workspace.findValidInvitation(String((req.body && req.body.token) || ''), hostCabinetId(req));
  if (!f) return res.status(410).json({ error: 'Cette invitation est invalide, expirée ou déjà utilisée.', code: 'invitation_invalid' });
  res.json({ email: f.inv.email, role: f.inv.role, roleLabel: (permissions.ROLES[f.inv.role] || {}).label, expiresAt: f.inv.expires_at,
    workspace: tenant.publicBranding(f.cab) });
});
router.post('/invitations/accept', inviteLimiter, (req, res) => {
  const b = req.body || {};
  try {
    const u = workspace.acceptInvitation(String(b.token || ''), hostCabinetId(req), { nom: b.nom, password: b.password });
    // Connexion automatique après acceptation : c'est une vraie première connexion (P3-15).
    try { db.prepare(`UPDATE utilisateur SET derniere_connexion=datetime('now') WHERE id=?`).run(u.id); } catch (_) {}
    audit(u.cabinet_id, u.id, 'login', 'utilisateur', { email: u.email, motif: 'invitation acceptée' }, req.ip);
    auth.setAuthCookie(res, auth.signToken(u));
    res.json({ ok: true, user: publicUser(u) });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

router.get('/tenant', (req, res) => {
  const ws = tenant.resolve(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ slug: ws.slug, ...tenant.publicBranding(ws.cabinet) });
});
function publicUser(u) {
  return { id: u.id, nom: u.nom, email: u.email, role: u.role,
    initiales: u.initiales || (u.nom || 'U').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase(),
    titre: u.titre || null };
}

// tout ce qui suit exige l'authentification
router.use(auth.requireAuth);
// Empreinte de session renvoyée à chaque réponse : l'interface compare l'utilisateur / le rôle affichés
// à ceux de la session RÉELLE et se réhydrate s'ils diffèrent (changement d'utilisateur, de rôle).
router.use((req, res, next) => { res.setHeader('X-DP-Session', `${req.user.id}:${req.user.role}`); next(); });
// Compte « Lecture seule » : aucune méthode d'écriture, quelle que soit la route (filet global).
router.use(permissions.readOnlyGuard);

/* ============================================================ ESPACE DE TRAVAIL (tenant) */
// Identité d'affichage du cabinet connecté. Lecture : tout utilisateur du cabinet.
router.get('/workspace', (req, res) => {
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.cabinetId);
  const hosts = cab && cab.slug ? tenant.baseDomains().map(d => `${cab.slug}.${d}`) : [];
  res.json({ workspace: tenant.workspaceOf(cab), hotes: hosts,
    options: { locales: tenant.LOCALES, devises: tenant.DEVISES, fuseaux: tenant.FUSEAUX } });
});
// Modification (administrateur) : champs d'AFFICHAGE uniquement — le slug (sous-domaine) et le
// plan relèvent du provisionnement. Aucun effet sur les calculs, périodes ou exports. Audité.
router.put('/workspace', (req, res) => {
  if (!permissions.guard(req, res, 'manage_workspace', "Seul un administrateur peut modifier l'identité de l'espace.")) return;
  const v = tenant.validateWorkspacePatch(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const before = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.cabinetId);
  const cols = Object.keys(v.values);
  db.prepare(`UPDATE cabinet SET ${cols.map(c => c + '=?').join(', ')} WHERE id=?`).run(...cols.map(c => v.values[c]), req.cabinetId);
  const avant = {}; for (const c of cols) avant[c] = before[c] == null ? null : before[c];
  audit(req.cabinetId, req.user.id, 'update', 'espace_travail', { avant, apres: v.values }, req.ip);
  db.prepare(`UPDATE cabinet SET updated_at=datetime('now') WHERE id=?`).run(req.cabinetId);
  const cab = db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.cabinetId);
  res.json({ ok: true, workspace: tenant.workspaceOf(cab) });
});
// Logo de l'espace (authentifié, propre cabinet uniquement).
router.get('/workspace/logo', (req, res) => {
  const f = workspace.logoFile(db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.cabinetId));
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.mime); res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(f.path);
});
router.post('/workspace/logo', upload.single('file'), (req, res) => {
  if (!permissions.guard(req, res, 'manage_workspace', 'Seul un administrateur peut changer le logo.')) { cleanupUploads(req); return; }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  try {
    workspace.saveLogo(req.cabinetId, req.file.path, req.file.size);
    audit(req.cabinetId, req.user.id, 'update', 'espace_logo', { taille: req.file.size }, req.ip);
    res.json({ ok: true, workspace: tenant.workspaceOf(db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.cabinetId)) });
  } catch (e) { res.status(e.status || 400).json({ error: e.message || 'Logo refusé.' }); }
});
router.delete('/workspace/logo', (req, res) => {
  if (!permissions.guard(req, res, 'manage_workspace', 'Seul un administrateur peut retirer le logo.')) return;
  workspace.removeLogo(req.cabinetId);
  audit(req.cabinetId, req.user.id, 'delete', 'espace_logo', {}, req.ip);
  res.json({ ok: true, workspace: tenant.workspaceOf(db.prepare('SELECT * FROM cabinet WHERE id=?').get(req.cabinetId)) });
});

// Changement de SON mot de passe (tout rôle) : mot de passe actuel exigé, audit sans aucun secret.
router.put('/me/password', (req, res) => {
  const b = req.body || {};
  const u = db.prepare('SELECT * FROM utilisateur WHERE id=?').get(req.user.id);
  if (!auth.verifyPassword(String(b.current || ''), u.password_hash)) return res.status(400).json({ error: 'Mot de passe actuel incorrect.' });
  const err = workspace.passwordProblem(b.next); if (err) return res.status(400).json({ error: err });
  if (b.next === b.current) return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l’actuel.' });
  db.prepare('UPDATE utilisateur SET password_hash=? WHERE id=?').run(auth.hashPassword(b.next), u.id);
  audit(req.cabinetId, u.id, 'update', 'mot_de_passe', {}, req.ip);
  res.json({ ok: true });
});

/* ============================================================ UTILISATEURS & INVITATIONS (admin) */
router.get('/roles', (req, res) => res.json({ roles: permissions.ROLES, matrice: permissions.publicMatrix() }));
router.get('/users', (req, res) => {
  if (!permissions.guard(req, res, 'manage_users', 'Seul un administrateur peut gérer les utilisateurs.')) return;
  res.json({ users: workspace.listUsers(req.cabinetId), invitations: workspace.listInvitations(req.cabinetId) });
});
router.patch('/users/:uid', (req, res) => {
  if (!permissions.guard(req, res, 'manage_users', 'Seul un administrateur peut gérer les utilisateurs.')) return;
  try { res.json({ ok: true, user: workspace.updateUser(req.cabinetId, req.user.id, req.params.uid, req.body || {}) }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.post('/invitations', (req, res) => {
  if (!permissions.guard(req, res, 'manage_users', 'Seul un administrateur peut inviter des utilisateurs.')) return;
  try {
    const inv = workspace.createInvitation(req.cabinetId, req.user.id, req.body || {});
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, invitation: inv }); // jeton renvoyé UNE seule fois, jamais journalisé
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
router.delete('/invitations/:iid', (req, res) => {
  if (!permissions.guard(req, res, 'manage_users', 'Seul un administrateur peut révoquer une invitation.')) return;
  try { workspace.revokeInvitation(req.cabinetId, req.user.id, req.params.iid); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/* ============================================================ ONBOARDING (progression par espace) */
router.get('/onboarding', (req, res) => res.json(workspace.onboardingState(req.cabinetId)));
router.put('/onboarding', (req, res) => {
  if (!permissions.guard(req, res, 'onboarding')) return;
  try { res.json(workspace.updateOnboarding(req.cabinetId, req.user.id, req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/* ============================================================ DASHBOARD */
router.get('/dashboard', (req, res) => {
  const cid = req.cabinetId;
  const clients = db.prepare('SELECT COUNT(*) n FROM entreprise WHERE cabinet_id=?').get(cid).n;
  // Période : celle fournie par le contexte global ; sinon la plus fournie.
  const per = (req.query.annee && req.query.trimestre)
    ? { annee: +req.query.annee, trimestre: +req.query.trimestre }
    : (db.prepare(`SELECT annee, trimestre, COUNT(*) n FROM facture WHERE cabinet_id=? AND annee IS NOT NULL
                   GROUP BY annee, trimestre ORDER BY n DESC, annee DESC, trimestre DESC LIMIT 1`).get(cid)
       || { annee: new Date().getFullYear(), trimestre: Math.floor(new Date().getMonth() / 3) + 1 });
  const facturesTrim = db.prepare('SELECT COUNT(*) n FROM facture WHERE cabinet_id=? AND annee=? AND trimestre=?').get(cid, per.annee, per.trimestre).n;
  const agg = db.prepare(`SELECT COUNT(*) nRet, COALESCE(SUM(ttc),0) mttc, COALESCE(SUM(montant_amende),0) amende
                          FROM facture WHERE cabinet_id=? AND annee=? AND trimestre=? AND a_declarer=1`).get(cid, per.annee, per.trimestre);
  const convManquantes = anomalies.conventionsManquantes({ cabinetId: cid }).length;

  // évolution 12 mois (montant amende par mois de paiement)
  const evo = db.prepare(`SELECT substr(date_paiement,1,7) ym, COALESCE(SUM(montant_amende),0) v
     FROM facture WHERE cabinet_id=? AND a_declarer=1 AND date_paiement IS NOT NULL
     GROUP BY ym ORDER BY ym`).all(cid);
  // top entreprises à risque
  const top = db.prepare(`SELECT e.id, e.raison_sociale name, e.ville city, COALESCE(SUM(f.ttc),0) amt,
        COALESCE(SUM(f.montant_amende),0) amende
     FROM entreprise e JOIN facture f ON f.entreprise_id=e.id
     WHERE e.cabinet_id=? AND f.a_declarer=1
     GROUP BY e.id ORDER BY amende DESC LIMIT 6`).all(cid);
  // heatmap : top 5 entreprises × 6 derniers mois
  const heatEnts = top.slice(0, 5);
  const months = last6Months(per);
  const heat = heatEnts.map(e => ({
    name: e.name,
    cells: months.map(mo => {
      const v = db.prepare(`SELECT COALESCE(SUM(montant_amende),0) a, COALESCE(SUM(ttc),0) t
         FROM facture WHERE entreprise_id=? AND substr(date_paiement,1,7)=? AND a_declarer=1`)
        .get(e.id, mo.ym);
      return { label: mo.label, amende: v.a, ttc: v.t };
    }),
  }));

  // KPIs additionnels
  const assujettis = db.prepare('SELECT COUNT(*) n FROM entreprise WHERE cabinet_id=? AND ca_ht>2000000').get(cid).n;
  const fournisseurs = db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE cabinet_id=?').get(cid).n;
  const convValides = db.prepare(`SELECT COUNT(*) n FROM convention WHERE cabinet_id=? AND statut='valide'`).get(cid).n;
  const paidAgg = db.prepare(`SELECT COUNT(*) paid, COALESCE(AVG(delai_ecoule),0) dso FROM facture WHERE cabinet_id=? AND annee=? AND trimestre=? AND date_paiement IS NOT NULL`).get(cid, per.annee, per.trimestre);
  const retMoy = db.prepare(`SELECT COALESCE(AVG(retard_jours),0) r FROM facture WHERE cabinet_id=? AND annee=? AND trimestre=? AND a_declarer=1`).get(cid, per.annee, per.trimestre).r;
  const tauxConf = paidAgg.paid > 0 ? Math.round(((paidAgg.paid - agg.nRet) / paidAgg.paid) * 1000) / 10 : 100;
  const anoCounts = anomalies.anomalyCounts({ cabinetId: cid });
  const seg = { ok: 0, app: 0, orange: 0, red: 0, dred: 0 };
  db.prepare(`SELECT couleur_risque c, COUNT(*) n FROM facture WHERE cabinet_id=? AND annee=? AND trimestre=? GROUP BY couleur_risque`).all(cid, per.annee, per.trimestre).forEach(r => { if (seg[r.c] != null) seg[r.c] = r.n; });
  const topFour = db.prepare(`SELECT fo.raison_sociale name, fo.ice, COALESCE(SUM(f.montant_amende),0) amende, COUNT(f.id) nb
     FROM fournisseur fo JOIN facture f ON f.fournisseur_id=fo.id
     WHERE fo.cabinet_id=? AND f.a_declarer=1 GROUP BY fo.id ORDER BY amende DESC LIMIT 5`).all(cid);

  const _info = periode.periodInfo(per.annee, per.trimestre);
  const MOIS = ['', 'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  res.json({
    periode: per,
    calendrier: {
      label: _info.label, date_debut: _info.date_debut, date_fin: _info.date_fin,
      mois_traitement: MOIS[_info.mois_traitement], annee_traitement: _info.annee_traitement,
      echeance: _info.date_cloture_prev, joursAvantEcheance: periode.joursAvantEcheance(per.annee, per.trimestre),
    },
    kpis: {
      clients, assujettis, fournisseurs, facturesTrim, enRetard: agg.nRet, montantConcerne: agg.mttc,
      amendePotentielle: agg.amende, montantAVerser: agg.amende, conventionsManquantes: convManquantes,
      convValides, tauxConformite: tauxConf, dso: Math.round(paidAgg.dso), retardMoyen: Math.round(retMoy), anomalies: anoCounts.aTraiter, anomaliesDetail: anoCounts,
    },
    segmentation: seg,
    topFournisseurs: topFour.map(t => ({ name: t.name || '—', ice: t.ice, amende: t.amende, nb: t.nb })),
    evolution: evo,
    topRisk: top.slice(0, 5).map(t => ({ name: t.name, city: t.city || '—', amt: t.amt, amende: t.amende })),
    heatmapMonths: months.map(m => m.label),
    heatmap: heat,
    deadlines: nextDeadlines(),
  });
});
function last6Months(per) {
  // 6 mois se terminant à la fin du trimestre `per`
  const endM = per.trimestre * 3; let y = per.annee, m = endM;
  const arr = [];
  for (let i = 0; i < 6; i++) {
    arr.unshift({ ym: `${y}-${String(m).padStart(2, '0')}`, label: ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'][m - 1] });
    m--; if (m < 1) { m = 12; y--; }
  }
  return arr;
}
function nextDeadlines() {
  const today = new Date();
  const deadlines = [
    { d: 30, mon: 'Avr', trimestre: 'T1', label: 'Déclaration T1', month: 3 },
    { d: 31, mon: 'Jul', trimestre: 'T2', label: 'Déclaration T2', month: 6 },
    { d: 31, mon: 'Oct', trimestre: 'T3', label: 'Déclaration T3', month: 9 },
    { d: 31, mon: 'Jan', trimestre: 'T4', label: 'Déclaration T4', month: 0 },
  ];
  return deadlines.map(dl => {
    let year = today.getFullYear();
    let dd = new Date(year, dl.month, dl.d);
    if (dl.month === 0) dd = new Date(year + 1, 0, 31);
    if (dd < today) dd = new Date(dd.getFullYear() + 1, dd.getMonth(), dd.getDate());
    const days = Math.round((dd - today) / 86400000);
    return { day: dl.d, mon: dl.mon, label: dl.label, sub: `${dl.trimestre} · dépôt SIMPL`, cd: `J-${days}`, days };
  }).sort((a, b) => a.days - b.days).slice(0, 4);
}

/* ============================================================ CLIENTS */
router.get('/clients', (req, res) => {
  // Portefeuille : « En retard » et « Amende » suivent la PÉRIODE ACTIVE quand elle est fournie
  // (annee/trimestre) ; sans période (sélecteur de client / init) → cumul toutes périodes.
  const hasP = !!(req.query.annee && req.query.trimestre);
  const pa = +req.query.annee, pt = +req.query.trimestre;
  const perFilter = hasP ? 'AND f.annee=? AND f.trimestre=?' : '';
  const rows = db.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM facture f WHERE f.entreprise_id=e.id AND f.a_declarer=1 ${perFilter}) retards,
      (SELECT COALESCE(SUM(f.montant_amende),0) FROM facture f WHERE f.entreprise_id=e.id AND f.a_declarer=1 ${perFilter}) amende
      FROM entreprise e WHERE e.cabinet_id=? ORDER BY e.raison_sociale`)
    .all(...(hasP ? [pa, pt, pa, pt, req.cabinetId] : [req.cabinetId]));
  res.json(rows.map(e => ({
    id: e.id, name: e.raison_sociale, ice: e.ice, if: e.if_fiscal, rc: e.rc, ville: e.ville,
    ca: e.ca_ht, secteur: e.secteur, expert: e.expert_responsable || '—',
    assujettie: assujettie(e.ca_ht), regime: regimeOf(e.ca_ht, e.exercice_ref || 2026),
    visa: visaOf(e.ca_ht), retards: e.retards, amende: e.amende,
    risk: e.retards === 0 ? 'ok' : (e.amende >= 5000 ? 'dred' : 'red'),
  })));
});
router.post('/clients', (req, res) => {
  const b = req.body || {};
  if (!b.raison_sociale) return res.status(400).json({ error: 'Raison sociale requise.' });
  const id = uid('ent');
  db.prepare(`INSERT INTO entreprise (id, cabinet_id, raison_sociale, ice, if_fiscal, rc, forme_juridique,
      secteur, ville, adresse, ca_ht, exercice_ref, email, telephone, expert_responsable)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.cabinetId, b.raison_sociale, normalizeIce(b.ice), b.if_fiscal || null, b.rc || null,
      b.forme_juridique || null, b.secteur || null, b.ville || null, b.adresse || null,
      Number(b.ca_ht) || 0, Number(b.exercice_ref) || 2026, b.email || null, b.telephone || null, b.expert_responsable || null);
  audit(req.cabinetId, req.user.id, 'create', 'entreprise', { id, nom: b.raison_sociale }, req.ip);
  res.json({ ok: true, id });
});
router.get('/clients/:id', (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) return notFound(res, 'client');
  e.assujettie = assujettie(e.ca_ht); e.regime = regimeOf(e.ca_ht, e.exercice_ref || 2026); e.type_visa = visaOf(e.ca_ht);
  res.json(e);
});
router.put('/clients/:id', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const b = req.body || {};
  db.prepare(`UPDATE entreprise SET raison_sociale=?, ice=?, if_fiscal=?, rc=?, forme_juridique=?, secteur=?,
      ville=?, adresse=?, ca_ht=?, exercice_ref=?, email=?, telephone=?, expert_responsable=? WHERE id=?`)
    .run(b.raison_sociale ?? e.raison_sociale, normalizeIce(b.ice) ?? e.ice, b.if_fiscal ?? e.if_fiscal,
      b.rc ?? e.rc, b.forme_juridique ?? e.forme_juridique, b.secteur ?? e.secteur, b.ville ?? e.ville,
      b.adresse ?? e.adresse, b.ca_ht != null ? Number(b.ca_ht) : e.ca_ht, b.exercice_ref ?? e.exercice_ref,
      b.email ?? e.email, b.telephone ?? e.telephone, b.expert_responsable ?? e.expert_responsable, e.id);
  audit(req.cabinetId, req.user.id, 'update', 'entreprise', { id: e.id }, req.ip);
  res.json({ ok: true });
});
router.delete('/clients/:id', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  if (!permissions.guard(req, res, 'delete_client', 'Seul un administrateur peut supprimer un dossier client et toutes ses données.')) return;
  const declIds = db.prepare('SELECT id FROM declaration WHERE entreprise_id=?').all(e.id).map(d => d.id);
  for (const did of declIds) {
    db.prepare('DELETE FROM ligne_declaration WHERE declaration_id=?').run(did);
    db.prepare('DELETE FROM visa WHERE declaration_id=?').run(did);
  }
  db.prepare('DELETE FROM declaration WHERE entreprise_id=?').run(e.id);
  db.prepare('DELETE FROM facture WHERE entreprise_id=?').run(e.id);
  db.prepare('DELETE FROM convention WHERE entreprise_id=?').run(e.id);
  db.prepare('DELETE FROM fournisseur WHERE entreprise_id=?').run(e.id);
  db.prepare('DELETE FROM anomalie WHERE entreprise_id=?').run(e.id);
  db.prepare('DELETE FROM document WHERE entreprise_id=?').run(e.id);
  db.prepare('DELETE FROM entreprise WHERE id=?').run(e.id);
  audit(req.cabinetId, req.user.id, 'delete', 'entreprise', { id: e.id, nom: e.raison_sociale }, req.ip);
  res.json({ ok: true });
});

router.get('/clients/:id/summary', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  // Période ACTIVE fournie par le contexte global (annee/trimestre) ; sinon la plus récente.
  // La fiche client doit refléter EXACTEMENT la période sélectionnée (jamais figée sur « la dernière »).
  const p = (req.query.annee && req.query.trimestre)
    ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  const agg = db.prepare(`SELECT COUNT(*) nb, COALESCE(SUM(CASE WHEN a_declarer=1 THEN 1 ELSE 0 END),0) aDecl,
      COALESCE(SUM(CASE WHEN a_declarer=1 THEN ttc ELSE 0 END),0) ttcRetard,
      COALESCE(SUM(montant_amende),0) amende
      FROM facture WHERE entreprise_id=? AND annee=? AND trimestre=?`).get(e.id, p.annee, p.trimestre);
  const fournisseurs = db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE entreprise_id=?').get(e.id).n;
  const conventions = db.prepare(`SELECT COUNT(*) n FROM convention WHERE entreprise_id=? AND statut='valide'`).get(e.id).n;
  const convManq = anomalies.conventionsManquantes({ cabinetId: req.cabinetId, entrepriseId: e.id }).length;
  const anoCounts = anomalies.anomalyCounts({ cabinetId: req.cabinetId, entrepriseId: e.id });
  const periods = db.prepare(`SELECT DISTINCT annee, trimestre FROM facture WHERE entreprise_id=? AND annee IS NOT NULL ORDER BY annee DESC, trimestre DESC`).all(e.id);
  res.json({
    entreprise: { ...e, assujettie: assujettie(e.ca_ht), regime: regimeOf(e.ca_ht, e.exercice_ref || 2026), type_visa: visaOf(e.ca_ht) },
    periode: p, periods,
    kpis: { fournisseurs, conventions, convManq, anomalies: anoCounts.aTraiter, anomaliesDetail: anoCounts, factures: agg.nb, aDeclarer: agg.aDecl, ttcRetard: agg.ttcRetard, amende: agg.amende },
  });
});

router.get('/clients/:id/periods', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const info = buildPeriodsList(req.cabinetId, e.id);
  // `latest` conservé pour compat ; défaut = période de travail si elle contient des données, sinon la plus fournie.
  const hasWork = info.disponibles.some(d => d.annee === info.travail.annee && d.trimestre === info.travail.trimestre);
  const latest = hasWork ? info.travail : (info.plusFournie || latestPeriod(e.id));
  res.json({ periods: info.disponibles, latest, travail: info.travail, plusFournie: info.plusFournie, disponibles: info.disponibles });
});

// Détail + calendrier + statut d'une période précise (crée la ligne si absente).
router.get('/clients/:id/periods/:annee/:trimestre/summary', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const p = requirePeriod(req, res); if (!p) return;
  const pr = ensurePeriode(req.cabinetId, e.id, p.annee, p.trimestre);
  const info = periode.periodInfo(p.annee, p.trimestre);
  const agg = db.prepare(`SELECT COUNT(*) nb,
      COALESCE(SUM(CASE WHEN a_declarer=1 THEN 1 ELSE 0 END),0) aDecl,
      COALESCE(SUM(CASE WHEN a_declarer=1 THEN ttc ELSE 0 END),0) ttcRetard,
      COALESCE(SUM(montant_amende),0) amende
      FROM facture WHERE entreprise_id=? AND annee=? AND trimestre=?`).get(e.id, p.annee, p.trimestre);
  const docs = db.prepare('SELECT COUNT(*) n FROM document WHERE entreprise_id=? AND annee=? AND trimestre=?').get(e.id, p.annee, p.trimestre).n;
  const lots = db.prepare('SELECT COUNT(*) n FROM import_lot WHERE entreprise_id=? AND annee=? AND trimestre=? AND statut=?').get(e.id, p.annee, p.trimestre, 'confirme').n;
  const anoPer = anomalies.anomalyCounts({ cabinetId: req.cabinetId, entrepriseId: e.id }).aTraiter;
  res.json({
    periode: { annee: p.annee, trimestre: p.trimestre, ...info,
      statut: pr.statut, statutLabel: periode.STATUT_LABELS[pr.statut], verrouillee: periode.isLocked(pr.statut),
      date_cloture: pr.date_cloture, joursAvantEcheance: periode.joursAvantEcheance(p.annee, p.trimestre),
      date_reouverture: pr.date_reouverture || null, motif_reouverture: pr.motif_reouverture || null,
      historique: periodHistory(req.cabinetId, e.id, p.annee, p.trimestre) },
    kpis: { documents: docs, lots, factures: agg.nb, aDeclarer: agg.aDecl, ttcRetard: agg.ttcRetard, amende: agg.amende, anomalies: anoPer },
  });
});

// Historique LECTURE SEULE des clôtures / réouvertures d'une période, reconstitué depuis le journal
// d'audit (qui, quand, motif). Aucune écriture : simple restitution de la traçabilité existante.
function periodHistory(cabinetId, entrepriseId, annee, trimestre) {
  return db.prepare(`SELECT a.action, a.created_at, a.details, u.nom user_nom FROM audit_log a
      LEFT JOIN utilisateur u ON u.id=a.user_id
      WHERE a.cabinet_id=? AND a.action IN ('cloture_periode','reouverture_periode')
        AND (CASE WHEN json_valid(a.details) THEN json_extract(a.details,'$.entreprise') END)=?
        AND (CASE WHEN json_valid(a.details) THEN json_extract(a.details,'$.annee') END)=?
        AND (CASE WHEN json_valid(a.details) THEN json_extract(a.details,'$.trimestre') END)=?
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT 20`).all(cabinetId, entrepriseId, annee, trimestre)
    .map(r => { let d = {}; try { d = JSON.parse(r.details || '{}'); } catch (_) {}
      return { action: r.action === 'cloture_periode' ? 'cloture' : 'reouverture', date: r.created_at,
               par: r.user_nom || null, avant: d.avant || null, apres: d.apres || null, motif: d.motif || null }; });
}

// Clôture d'une période (réservé admin) → lecture seule.
router.post('/clients/:id/periods/:annee/:trimestre/close', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Seul un administrateur peut clôturer une période.' });
  const p = requirePeriod(req, res); if (!p) return;
  const pr = ensurePeriode(req.cabinetId, e.id, p.annee, p.trimestre);
  const statutAvant = pr.statut;
  const statut = (req.body && req.body.statut === 'declaree') ? 'declaree' : 'cloturee';
  // VISA-1 : vérifications en attente → accusé explicite obligatoire (la clôture reste possible, jamais silencieuse).
  const verifs = pendingChecks(req.cabinetId, e, p);
  if (verifs.total > 0 && !(req.body && req.body.ackVerifications === true))
    return res.status(409).json({ code: 'verifications_en_attente', verifications: verifs,
      error: `Des vérifications sont en attente sur T${p.trimestre} ${p.annee} : confirmez que vous clôturez en connaissance de cause.` });
  // Fige l'état EXACT au moment du verrouillage (recalcul possible tant que non verrouillée),
  // puis verrouille : les valeurs ne bougeront plus (recomputePeriod devient no-op ensuite).
  recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  // LOT 7 — arrête aussi le TABLEAU DÉCLARATIF (lignes retenues + exclusions réseau + en-tête
  // ca_ht/type_visa) AVANT de verrouiller : c'est ce snapshot que tous les exports reliront.
  buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  db.prepare(`UPDATE periode_declaration SET statut=?, date_cloture=datetime('now'), cloturee_par=?, updated_at=datetime('now') WHERE id=?`)
    .run(statut, req.user.id, pr.id);
  audit(req.cabinetId, req.user.id, 'cloture_periode', 'periode', { entreprise: e.id, annee: p.annee, trimestre: p.trimestre, avant: statutAvant, apres: statut,
    verifications_en_attente: verifs, accuse_verifications: verifs.total > 0 }, req.ip);
  res.json({ ok: true, statut });
});

// Réouverture exceptionnelle (réservé admin, motif obligatoire) → audit.
router.post('/clients/:id/periods/:annee/:trimestre/reopen', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Seul un administrateur peut rouvrir une période.' });
  const motif = (req.body && req.body.motif || '').trim();
  if (!motif) return res.status(400).json({ error: 'Motif de réouverture obligatoire.' });
  const p = requirePeriod(req, res); if (!p) return;
  const pr = ensurePeriode(req.cabinetId, e.id, p.annee, p.trimestre);
  // Réouverture LIMITÉE à cette seule période ; seule une période verrouillée peut être rouverte.
  if (!periode.isLocked(pr.statut)) return res.status(409).json({ error: `Période ${periode.periodInfo(p.annee, p.trimestre).label} non clôturée (${periode.STATUT_LABELS[pr.statut] || pr.statut}) : rien à rouvrir.`, statut: pr.statut });
  const statutAvant = pr.statut;
  db.prepare(`UPDATE periode_declaration SET statut='rouverte', date_reouverture=datetime('now'), motif_reouverture=?, cloturee_par=?, updated_at=datetime('now') WHERE id=?`)
    .run(motif, req.user.id, pr.id);
  audit(req.cabinetId, req.user.id, 'reouverture_periode', 'periode', { entreprise: e.id, annee: p.annee, trimestre: p.trimestre, avant: statutAvant, apres: 'rouverte', motif }, req.ip);
  res.json({ ok: true, statut: 'rouverte' });
});

router.get('/clients/:id/fournisseurs', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const rows = db.prepare(`SELECT f.*,
      (SELECT COUNT(*) FROM convention c WHERE c.fournisseur_id=f.id AND c.statut='valide') has_conv
      FROM fournisseur f WHERE f.entreprise_id=? ORDER BY f.raison_sociale`).all(e.id);
  // Délai appliqué et sa SOURCE (moteur : reseau.resolveDelaiAutorise) + indicateur « sans convention justificative » (CONV-1).
  const manq = new Set(anomalies.conventionsManquantes({ cabinetId: req.cabinetId, entrepriseId: e.id }).map(x => x.id));
  res.json(rows.map(f => {
    const r = reseau.resolveDelaiAutorise({ fournisseur: f, convention: activeConventionFor(e.id, f.id) });
    return { ...f, delai_regle: r.delaiAutorise, source_regle: r.sourceRegle, source_label: anomalies.SOURCE_FR[r.sourceRegle] || r.sourceRegle, sans_convention_justificative: manq.has(f.id) };
  }));
});
router.post('/clients/:id/fournisseurs', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const b = req.body || {};
  const id = uid('four');
  db.prepare(`INSERT INTO fournisseur (id, cabinet_id, entreprise_id, raison_sociale, ice, if_fiscal, rc, adresse, secteur, email, delai_applicable)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.cabinetId, e.id, b.raison_sociale || null, normalizeIce(b.ice), b.if_fiscal || null, b.rc || null,
      b.adresse || null, b.secteur || null, b.email || null, Number(b.delai_applicable) || 60);
  res.json({ ok: true, id });
});

/* ============================================================ CONVENTIONS */
router.get('/clients/:id/conventions', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const rows = db.prepare(`SELECT c.*, f.raison_sociale four_nom, f.ice four_ice, f.if_fiscal four_if
      FROM convention c LEFT JOIN fournisseur f ON f.id=c.fournisseur_id
      WHERE c.entreprise_id=? ORDER BY c.created_at DESC`).all(e.id);
  // Règle EFFECTIVEMENT appliquée au fournisseur (lecture seule) — via les fonctions centrales
  // uniques (LOT 4 : activeConventionFor → resolveDelaiAutorise), jamais recalculée ici.
  const regleCache = new Map();
  const regleOf = (fid) => {
    if (!fid) return null;
    if (!regleCache.has(fid)) {
      const four = db.prepare('SELECT * FROM fournisseur WHERE id=? AND entreprise_id=?').get(fid, e.id);
      const active = activeConventionFor(e.id, fid);
      const r = reseau.resolveDelaiAutorise({ fournisseur: four, convention: active });
      regleCache.set(fid, { delai: r.delaiAutorise, source: r.sourceRegle, conventionId: active ? active.id : null });
    }
    return regleCache.get(fid);
  };
  res.json(rows.map(c => {
    const regle = regleOf(c.fournisseur_id);
    return {
      id: c.id, fournisseur: c.four_nom, four_ice: c.four_ice, four_if: c.four_if, fournisseur_id: c.fournisseur_id,
      objet: c.objet, delai: c.delai_convenu, date_signature: c.date_signature, date_debut: c.date_debut, date_fin: c.date_fin,
      statut: computeConvStatut(c), conforme: !!c.conforme, fichier: c.fichier ? c.id : null, fichier_nom: c.fichier_nom,
      created_at: c.created_at,
      regle_fournisseur: regle ? { delai: regle.delai, source: regle.source } : null,
      appliquee: !!(regle && regle.source === 'convention' && regle.conventionId === c.id),
      // INC 2.1-D : appliquée par le moteur mais hors de sa période de validité pour le trimestre consulté (ou échue).
      hors_validite: !!(regle && regle.source === 'convention' && regle.conventionId === c.id
        && ((req.query.annee && anomalies.covers(c, +req.query.annee, +req.query.trimestre) === false) || computeConvStatut(c) === 'Expirée')),
    };
  }));
});
function computeConvStatut(c) {
  if (c.date_fin) {
    const fin = new Date(c.date_fin), today = new Date();
    if (fin < today) return 'Expirée';
    if ((fin - today) / 86400000 <= 30) return 'Bientôt expirée';
  }
  return 'Trouvée';
}
// Délai conventionnel SAISI EXPLICITEMENT : entier strict 1..120, sinon null (refus).
// AUCUNE valeur par défaut, AUCUNE extraction — un délai absent, non entier ou hors plage est refusé
// (jamais de « 120 » silencieux présenté comme un résultat d'analyse du document).
function parseDelaiConventionExplicite(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^\d{1,3}$/.test(s)) return null;   // entier strict (pas de décimal/texte/signe)
  const n = parseInt(s, 10);
  return (n >= 1 && n <= 120) ? n : null;
}
// Document de convention accepté = PDF, JPEG ou PNG, validé par les OCTETS D'EN-TÊTE (on ne fait pas
// confiance à l'extension ni au client). Le document est ARCHIVÉ tel quel : aucune analyse/OCR n'a lieu.
function conventionDocKind(filePath, originalname) {
  const ext = path.extname(originalname || '').toLowerCase();
  let h;
  try { const fd = fs.openSync(filePath, 'r'); h = Buffer.alloc(8); fs.readSync(fd, h, 0, 8, 0); fs.closeSync(fd); }
  catch (_) { return null; }
  if (ext === '.pdf' && h.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if ((ext === '.jpg' || ext === '.jpeg') && h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return 'jpeg';
  if (ext === '.png' && h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) return 'png';
  return null;
}
router.post('/clients/:id/conventions', upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) { cleanupUploads(req); return notFound(res, 'client'); }
  const b = req.body || {};
  // 1) Délai OBLIGATOIRE et EXPLICITE (aucun OCR n'existe) — refusé AVANT toute écriture, sans défaut 120.
  const delaiConv = parseDelaiConventionExplicite(b.delai);
  if (delaiConv == null) {
    cleanupUploads(req);
    return res.status(400).json({ error: 'Le délai conventionnel est obligatoire : saisissez un entier entre 1 et 120 jours. Aucune valeur n\'est extraite automatiquement du document.' });
  }
  // 2) Document éventuel : PDF / JPEG / PNG uniquement — archivé, jamais analysé.
  const docKind = req.file ? conventionDocKind(req.file.path, req.file.originalname) : null;
  if (req.file && !docKind) {
    cleanupUploads(req);
    return res.status(400).json({ error: 'Format de document non pris en charge. Formats acceptés : PDF, JPEG, PNG.' });
  }
  let fournisseurId = b.fournisseur_id;
  // Un fournisseur fourni explicitement DOIT appartenir à cette entreprise (anti-IDOR).
  if (fournisseurId && !db.prepare('SELECT 1 FROM fournisseur WHERE id=? AND entreprise_id=?').get(fournisseurId, e.id)) {
    cleanupUploads(req); return res.status(400).json({ error: 'Fournisseur invalide.' });
  }
  // upsert fournisseur si nécessaire
  if (!fournisseurId && (b.four_ice || b.four_if || b.fournisseur)) {
    const iceN = normalizeIce(b.four_ice);
    let f = iceN ? db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND ice=?').get(e.id, iceN) : null;
    if (!f && b.four_if) f = db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND if_fiscal=?').get(e.id, String(b.four_if));
    if (f) fournisseurId = f.id;
    else {
      fournisseurId = uid('four');
      db.prepare(`INSERT INTO fournisseur (id, cabinet_id, entreprise_id, raison_sociale, ice, if_fiscal, delai_applicable)
                  VALUES (?,?,?,?,?,?,?)`).run(fournisseurId, req.cabinetId, e.id, b.fournisseur || null, iceN, b.four_if || null, delaiConv);
    }
  }
  const cd = convDates(b);
  if (cd.errs.length) { cleanupUploads(req); return res.status(400).json({ error: cd.errs.join(' ') }); }
  Object.assign(b, cd.out);
  if (b.date_debut && b.date_fin && b.date_fin < b.date_debut) { cleanupUploads(req); return res.status(400).json({ error: 'La date de fin est antérieure à la date d’effet : corrigez l’une des deux dates.' }); }
  const id = uid('conv');
  db.prepare(`INSERT INTO convention (id, cabinet_id, entreprise_id, fournisseur_id, objet, delai_convenu,
      date_signature, date_debut, date_fin, statut, conforme, fichier, fichier_nom)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.cabinetId, e.id, fournisseurId || null, b.objet || 'Délais de paiement', delaiConv,
      b.date_signature || null, b.date_debut || null, b.date_fin || null, 'valide',
      1, req.file ? req.file.filename : null, req.file ? req.file.originalname : null);
  if (fournisseurId) db.prepare('UPDATE fournisseur SET delai_applicable=? WHERE id=?').run(delaiConv, fournisseurId);
  // Recalcul de toutes les périodes NON clôturées de ce fournisseur (jamais les périodes verrouillées).
  if (fournisseurId) recomputeOpenPeriodsForFournisseurs(req.cabinetId, e.id, [fournisseurId]);
  else { const p = latestPeriod(e.id); recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre); }
  audit(req.cabinetId, req.user.id, 'create', 'convention', { id, entreprise: e.id, fournisseur: fournisseurId || null, delai: delaiConv, date_signature: b.date_signature || null, date_debut: b.date_debut || null, date_fin: b.date_fin || null, document: docKind }, req.ip);
  res.json({ ok: true, id });
});
// Dates d'une convention (INC 2.1-B) : signature, effet (début), fin. Format jj/mm/aaaa accepté côté UI, stocké ISO.
// Les dates alimentent l'AFFICHAGE et la VÉRIFICATION des anomalies ; le moteur applique toujours par statut (LOT 4).
function convDates(b) {
  const out = {}, errs = [];
  for (const [k, lbl] of [['date_signature', 'La date de signature'], ['date_debut', 'La date d’effet'], ['date_fin', 'La date de fin']]) {
    if (!(k in b)) continue;
    const v = b[k] == null ? '' : String(b[k]).trim();
    if (!v) { out[k] = null; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v + 'T00:00:00'))) { errs.push(`${lbl} est invalide : utilisez le format jj/mm/aaaa.`); continue; }
    out[k] = v;
  }
  return { out, errs };
}
router.patch('/clients/:id/conventions/:convId', (req, res) => {
  if (!permissions.guard(req, res, 'manage_conventions', 'Votre rôle ne permet pas de modifier une convention.')) return;
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND entreprise_id=?').get(req.params.convId, e.id);
  if (!c) return notFound(res, 'convention');
  const { out, errs } = convDates(req.body || {});
  if (errs.length) return res.status(400).json({ error: errs.join(' ') });
  const next = { date_signature: c.date_signature, date_debut: c.date_debut, date_fin: c.date_fin, ...out };
  if (next.date_debut && next.date_fin && next.date_fin < next.date_debut) return res.status(400).json({ error: 'La date de fin est antérieure à la date d’effet : corrigez l’une des deux dates.' });
  const changes = {};
  for (const k of Object.keys(out)) if ((c[k] || null) !== (out[k] || null)) changes[k] = { avant: c[k] || null, apres: out[k] || null };
  if (!Object.keys(changes).length) return res.json({ ok: true, unchanged: true });
  db.prepare('UPDATE convention SET date_signature=?, date_debut=?, date_fin=? WHERE id=?').run(next.date_signature, next.date_debut, next.date_fin, c.id);
  audit(req.cabinetId, req.user.id, 'update', 'convention', { id: c.id, modifications: changes }, req.ip);
  res.json({ ok: true, changes });
});
router.get('/conventions/:id/file', (req, res) => {
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND cabinet_id=?').get(req.params.id, req.cabinetId);
  if (!c || !c.fichier) return notFoundText(res, 'fichier');
  res.download(path.join(UP_DIR, c.fichier), c.fichier_nom || 'convention');
});

// Types de fichiers acceptés (validés côté serveur — on ne fait pas confiance au client).
const XLSX_EXT = new Set(['.xlsx', '.xls', '.xlsm']);
function isExcelUpload(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (XLSX_EXT.has(ext)) return true;
  const mt = String(file.mimetype || '').toLowerCase();
  return mt.includes('spreadsheetml') || mt.includes('ms-excel');
}

// Import d'une LISTE de conventions (Excel) — crée les conventions SANS le PDF (document différé).
router.post('/clients/:id/conventions/import', heavyLimiter, upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) { cleanupUploads(req); return notFound(res, 'client'); }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  if (!isExcelUpload(req.file)) { cleanupUploads(req); return res.status(400).json({ error: 'Format non pris en charge : importez un fichier Excel (.xlsx ou .xls). Utilisez le modèle fourni.' }); }
  try {
    const crypto = require('crypto');
    const buf = fs.readFileSync(req.file.path);
    const empreinte = crypto.createHash('sha256').update(buf).digest('hex');
    const r = require('./importer').importConventions(buf, {
      cabinetId: req.cabinetId, entrepriseId: e.id, userId: req.user.id,
      sourceName: req.file.originalname, empreinte,
    });
    cleanupUploads(req);
    // Recalcul de TOUTES les périodes NON clôturées des fournisseurs affectés (les nouveaux délais s'appliquent aux retards).
    const recompute = recomputeOpenPeriodsForFournisseurs(req.cabinetId, e.id, r.affectedFournisseurs);
    audit(req.cabinetId, req.user.id, 'import_conventions', 'convention',
      { file: req.file.originalname, batch: r.batchId, created: r.conventionsCreated, conflicts: r.conflicts, rejected: r.rejected, recompute }, req.ip);
    res.json({ ok: true, recompute, ...r });
  } catch (err) { cleanupUploads(req); res.status(400).json({ error: err.message }); }
});

// Assistant conventions (mapping libre, réutilise le token d'analyse) — PRÉVISUALISATION (aucune écriture).
router.post('/clients/:id/conventions/preview', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const b = req.body || {};
  const tmp = safeUploadPath(b.token, req); if (!tmp) return res.status(400).json({ error: 'Le fichier analysé n’est plus disponible (analyse trop ancienne ou page rechargée). Relancez l’analyse du fichier : rien n’a été importé.', code: 'analyse_expiree' });
  try {
    const r = importer.importConventions(fs.readFileSync(tmp), {
      cabinetId: req.cabinetId, entrepriseId: e.id, userId: req.user.id,
      sourceName: b.sourceName || 'conventions.xlsx', mapping: b.mapping || {}, sheetName: b.sheetName, headerRow: b.headerRow, dryRun: true,
    });
    res.json({ ok: true, ...r });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Assistant conventions — CONFIRMATION (écrit en transaction, recalcule les périodes ouvertes).
router.post('/clients/:id/conventions/confirm', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const b = req.body || {};
  const tmp = safeUploadPath(b.token, req); if (!tmp) return res.status(400).json({ error: 'Le fichier analysé n’est plus disponible (analyse trop ancienne ou page rechargée). Relancez l’analyse du fichier : rien n’a été importé.', code: 'analyse_expiree' });
  try {
    const crypto = require('crypto');
    const buf = fs.readFileSync(tmp);
    const empreinte = crypto.createHash('sha256').update(buf).digest('hex');
    const r = importer.importConventions(buf, {
      cabinetId: req.cabinetId, entrepriseId: e.id, userId: req.user.id, empreinte,
      sourceName: b.sourceName || 'conventions.xlsx', mapping: b.mapping || {}, sheetName: b.sheetName, headerRow: b.headerRow,
    });
    const recompute = recomputeOpenPeriodsForFournisseurs(req.cabinetId, e.id, r.affectedFournisseurs);
    audit(req.cabinetId, req.user.id, 'import_conventions', 'convention',
      { file: b.sourceName, batch: r.batchId, created: r.conventionsCreated, conflicts: r.conflicts, rejected: r.rejected, recompute, mapped: true }, req.ip);
    res.json({ ok: true, recompute, ...r });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Ajout (ou remplacement EXPLICITE) du document de convention (PDF/JPEG/PNG). Archivé, jamais analysé ;
// jamais d'écrasement silencieux.
router.post('/clients/:id/conventions/:convId/file', upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) { cleanupUploads(req); return notFound(res, 'client'); }
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND entreprise_id=? AND cabinet_id=?').get(req.params.convId, e.id, req.cabinetId);
  if (!c) { cleanupUploads(req); return notFound(res, 'convention'); }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  const kind = conventionDocKind(req.file.path, req.file.originalname);
  if (!kind) { cleanupUploads(req); return res.status(400).json({ error: 'Format de document non pris en charge. Formats acceptés : PDF, JPEG, PNG.' }); }
  const replacing = !!c.fichier;
  const confirmReplace = req.query.replace === '1' || String((req.body || {}).replace) === '1';
  if (replacing && !confirmReplace) { cleanupUploads(req); return res.status(409).json({ error: 'Un document est déjà rattaché à cette convention. Confirmez le remplacement.', hasFile: true }); }
  // Nom de fichier généré côté serveur (anti path-traversal — aucune donnée du client dans le chemin).
  const stored = 'conv_' + uid('f').slice(-12) + (kind === 'pdf' ? '.pdf' : kind === 'png' ? '.png' : '.jpg');
  try { fs.renameSync(req.file.path, path.join(UP_DIR, stored)); } catch (_) { fs.copyFileSync(req.file.path, path.join(UP_DIR, stored)); fs.unlink(req.file.path, () => {}); }
  const previous = c.fichier;
  db.prepare('UPDATE convention SET fichier=?, fichier_nom=? WHERE id=?').run(stored, req.file.originalname, c.id);
  if (replacing && previous) try { fs.unlinkSync(path.join(UP_DIR, previous)); } catch (_) {}   // après enregistrement, pour ne pas perdre l'ancien sur erreur
  audit(req.cabinetId, req.user.id, replacing ? 'convention_pdf_remplace' : 'convention_pdf_ajout', 'convention', { id: c.id, nom: req.file.originalname }, req.ip);
  res.json({ ok: true, replaced: replacing });
});

// Modèle Excel de liste de conventions (2 feuilles : Instructions + Conventions). Aucune donnée réelle.
router.get('/conventions/template.xlsx', (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modele_conventions_delaipay.xlsx"');
  res.send(require('./importer').buildConventionsTemplate());
});

/* ============================================================ RÈGLE OPÉRATEUR DE RÉSEAU */
// Classer / confirmer un fournisseur (règle de paiement applicable). Audité. Ne touche pas aux périodes clôturées.
router.patch('/clients/:id/fournisseurs/:fid/classification', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const f = db.prepare('SELECT * FROM fournisseur WHERE id=? AND entreprise_id=?').get(req.params.fid, e.id);
  if (!f) return notFound(res, 'fournisseur');
  const b = req.body || {};
  const op = b.operateur_reseau ? 1 : 0;
  const statut = b.statut === 'confirme' ? 'confirme' : (b.statut === 'a_verifier' ? 'a_verifier' : 'propose');
  const cat = b.categorie_fournisseur || (op ? 'autre_operateur_reseau' : 'standard');
  const hors = (op && statut === 'confirme' && b.hors_tableau_declaratif !== false) ? 1 : 0;
  db.prepare(`UPDATE fournisseur SET categorie_fournisseur=?, operateur_reseau=?, statut_classification=?, classification_source='manuelle',
     hors_tableau_declaratif=?, delai_special=?, motif_regle_speciale=?, date_validation=datetime('now'), utilisateur_validation=? WHERE id=?`)
    .run(cat, op, statut, hors, (op && statut === 'confirme') ? reseau.DELAI_RESEAU : null, op ? reseau.MOTIF_RESEAU : null, req.user.id, f.id);
  // Recalcul des périodes NON clôturées où ce fournisseur a des factures (jamais les périodes verrouillées).
  let recompute = 0;
  for (const p of db.prepare('SELECT DISTINCT annee, trimestre FROM facture WHERE entreprise_id=? AND fournisseur_id=? AND annee IS NOT NULL').all(e.id, f.id)) {
    const row = ensurePeriode(req.cabinetId, e.id, p.annee, p.trimestre);
    if (!periode.isLocked(row.statut)) { recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre); recompute++; }
  }
  audit(req.cabinetId, req.user.id, 'classification_fournisseur', 'fournisseur', { id: f.id, operateur_reseau: op, statut, hors_tableau: hors }, req.ip);
  res.json({ ok: true, recompute });
});
// Rapport de SIMULATION (lecture seule) — candidats « opérateur de réseau » et impact. NE modifie rien.
router.get('/clients/:id/reseau/simulation', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const candidats = [];
  for (const f of db.prepare('SELECT * FROM fournisseur WHERE entreprise_id=?').all(e.id)) {
    if (f.operateur_reseau && f.statut_classification === 'confirme') continue; // déjà appliqué
    const p = reseau.classifyReseau({ nom: f.raison_sociale });
    if (!p.isOperateur) continue;
    const a = db.prepare(`SELECT COUNT(*) nb, ROUND(SUM(ttc),2) ttc, ROUND(SUM(montant_amende),2) amende,
       COUNT(DISTINCT annee||'-'||trimestre) periodes FROM facture WHERE entreprise_id=? AND fournisseur_id=?`).get(e.id, f.id);
    candidats.push({ fournisseur_id: f.id, fournisseur: f.raison_sociale, ice: f.ice, if_fiscal: f.if_fiscal, rc: f.rc,
      alias: p.alias, categorie: p.categorie, ambigu: !!p.ambigu, confidence: p.confidence,
      nbFactures: a.nb, ttc: a.ttc, amende: a.amende, periodes: a.periodes,
      delaiActuel: calc.saneDelai(f.delai_applicable), delaiPropose: reseau.DELAI_RESEAU, statutActuel: f.statut_classification || 'non_classe' });
  }
  res.json({ candidats, total: candidats.length });
});

/* ============================================================ DELAIS (calc table) */
// Incidence reportée : factures d'un trimestre ANTÉRIEUR, non soldées avant Q, dont des mois de
// retard tombent dans Q → recalculées POUR Q. Additif : ne modifie pas les lignes stockées (dossier de référence intact).
function periodRank(a, t) { return (+a) * 4 + (+t); }
function incidenceFactures(cabinetId, entrepriseId, annee, trimestre) {
  const rank = periodRank(annee, trimestre);
  const cands = db.prepare(`SELECT f.*, fo.raison_sociale four_nom, fo.ice four_ice, fo.if_fiscal four_if,
      (SELECT COUNT(*) FROM convention c WHERE c.fournisseur_id=f.fournisseur_id AND c.statut='valide') has_conv
      FROM facture f LEFT JOIN fournisseur fo ON fo.id=f.fournisseur_id
      WHERE f.entreprise_id=? AND f.a_declarer=1 AND f.annee IS NOT NULL
        AND (f.annee*4 + f.trimestre) < ?
        AND (f.date_paiement IS NULL OR (CAST(substr(f.date_paiement,1,4) AS INTEGER)*4 + ((CAST(substr(f.date_paiement,6,2) AS INTEGER)-1)/3+1)) >= ?)`)
    .all(entrepriseId, rank, rank);
  const out = [];
  for (const f of cands) {
    const c = calc.computeFacture({ dateFacture: f.date_facture, datePaiement: f.date_paiement, ttc: f.ttc,
      delaiApplicable: f.delai_applicable, periode: { annee: +annee, trimestre: +trimestre },
      tauxProvider: (y, m) => tauxAt(y, m, cabinetId) });
    if (c.montantAmende > 0) out.push({ f, c });
  }
  return out;
}

// Données de la feuille de délais (factures de la période + incidences reportées + totaux).
// Fonction unique réutilisée par l'API JSON et par l'export Excel — même source de vérité.
function delaisData(cabinetId, e, p) {
  // LOT 7 — période VERROUILLÉE = feuille FIGÉE. Le délai autorisé et le retard sont relus depuis la
  // facture arrêtée à la clôture au lieu d'être re-résolus en direct : sans cela une convention (ou
  // une classification réseau) créée APRÈS la clôture affichait « 120 j / 0 j de retard » à côté
  // d'une amende gelée, produisant un export auto-contradictoire (réserve P3-2 du LOT 6).
  const prLock = db.prepare('SELECT statut FROM periode_declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(e.id, p.annee, p.trimestre);
  const figee = !!(prLock && periode.isLocked(prLock.statut));
  const rows = db.prepare(`SELECT f.*, fo.raison_sociale four_nom, fo.ice four_ice, fo.if_fiscal four_if,
      fo.operateur_reseau, fo.statut_classification, fo.hors_tableau_declaratif, fo.categorie_fournisseur, fo.delai_applicable fo_delai,
      (SELECT COUNT(*) FROM convention c WHERE c.fournisseur_id=f.fournisseur_id AND c.statut='valide') has_conv,
      (SELECT delai_convenu FROM convention c WHERE c.fournisseur_id=f.fournisseur_id AND c.statut='valide' ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1) conv_delai,
      (SELECT a.id FROM anomalie a WHERE a.type='doublon_potentiel' AND a.entite='facture' AND a.entite_id=f.id AND a.statut='ouverte' LIMIT 1) ano_doublon_id
      FROM facture f LEFT JOIN fournisseur fo ON fo.id=f.fournisseur_id
      WHERE f.entreprise_id=? AND f.annee=? AND f.trimestre=? ORDER BY f.montant_amende DESC, f.retard_jours DESC`)
    .all(e.id, p.annee, p.trimestre);
  const list = rows.map(f => {
    // Délai CONSTATÉ + date d'arrêté recalculés à la volée (source de vérité = moteur), pour
    // que la feuille soit toujours correcte selon la règle « arrêté au dernier jour du trimestre ».
    const arr = calc.getDateArreteFacture({ dateFacture: f.date_facture, datePaiement: f.date_paiement, annee: p.annee, trimestre: p.trimestre });
    // Délai AUTORISÉ résolu centralement (opérateur réseau 30 j prioritaire).
    const rd = reseau.resolveDelaiAutorise({ fournisseur: { operateur_reseau: f.operateur_reseau, statut_classification: f.statut_classification, hors_tableau_declaratif: f.hors_tableau_declaratif, motif_regle_speciale: f.motif_regle_speciale, delai_applicable: f.fo_delai }, convention: f.conv_delai != null ? { delai_convenu: f.conv_delai } : null });
    // Période figée : on relit la valeur ARRÊTÉE (celle qui a servi à calculer l'amende), pas la règle courante.
    const delaiApp = figee ? calc.saneDelai(f.delai_applicable) : rd.delaiAutorise;
    const retard = figee ? (f.retard_jours == null ? null : f.retard_jours)
      : (arr.delaiConstate == null ? null : Math.max(0, arr.delaiConstate - delaiApp));
    return {
      id: f.id, numero: f.numero, four: f.four_nom, four_id: f.fournisseur_id, four_if: f.four_if, four_ice: f.four_ice, nature: f.designation,
      ttc: f.ttc, mht: f.mht, tva: f.tva, date_facture: f.date_facture, date_paiement: f.date_paiement,
      delai_ecoule: arr.delaiConstate, delai_applicable: delaiApp, date_limite: f.date_limite,
      arrete_au: arr.dateArreteIso, etat_paiement: arr.etat,
      operateur_reseau: rd.sourceRegle === 'operateur_reseau', categorie: f.categorie_fournisseur || 'standard', hors_tableau: rd.horsTableauDeclaratif, source_regle: rd.sourceRegle,
      // LOT 2 — surface la PROPOSITION réseau (non confirmée) pour permettre la confirmation depuis l'UI.
      reseau_statut: (f.operateur_reseau && f.statut_classification === 'confirme') ? 'confirme'
        : ((f.statut_classification === 'propose' || f.statut_classification === 'a_verifier') || (!f.operateur_reseau && reseau.classifyReseau({ nom: f.four_nom }).isOperateur) ? 'propose' : 'aucun'),
      reseau_categorie: (() => { const p = reseau.classifyReseau({ nom: f.four_nom }); return f.categorie_fournisseur && f.categorie_fournisseur !== 'standard' ? f.categorie_fournisseur : (p.isOperateur ? p.categorie : null); })(),
      reseau_ambigu: (() => { const p = reseau.classifyReseau({ nom: f.four_nom }); return !!p.ambigu; })(),
      retard, n_mois: f.n_mois, a_declarer: !!f.a_declarer, has_conv: !!f.has_conv,
      taux_bam: f.taux_bam, taux_total: f.taux_total, amende: f.montant_amende, risk: f.couleur_risque,
      // Doublon potentiel : trace historique + état de revue courant (non destructif).
      doublon_potentiel: !!f.doublon_potentiel, motif_doublon: f.motif_doublon || null,
      statut_doublon: f.statut_doublon || 'aucun', date_revue_doublon: f.date_revue_doublon || null,
      utilisateur_revue_doublon: f.utilisateur_revue_doublon || null, anomalie_doublon_active: !!f.ano_doublon_id,
      incidence: false,
    };
  });
  // Incidence reportée (factures d'un trimestre antérieur qui pèsent encore sur Q)
  const inc = incidenceFactures(cabinetId, e.id, p.annee, p.trimestre).map(({ f, c }) => ({
    id: f.id, numero: f.numero, four: f.four_nom, four_id: f.fournisseur_id, four_if: f.four_if, four_ice: f.four_ice, nature: f.designation,
    ttc: f.ttc, mht: f.mht, tva: f.tva, date_facture: f.date_facture, date_paiement: f.date_paiement,
    delai_ecoule: c.delaiEcoule, delai_applicable: calc.saneDelai(f.delai_applicable), date_limite: c.dateLimite,
    arrete_au: c.arreteAu, etat_paiement: c.etatPaiement,
    retard: c.retardJours, n_mois: c.nMois, a_declarer: true, has_conv: !!f.has_conv,
    taux_bam: c.tauxBam, taux_total: c.tauxTotal, amende: c.montantAmende, risk: c.couleurRisque,
    doublon_potentiel: !!f.doublon_potentiel, motif_doublon: f.motif_doublon || null,
    statut_doublon: f.statut_doublon || 'aucun', date_revue_doublon: f.date_revue_doublon || null,
    utilisateur_revue_doublon: f.utilisateur_revue_doublon || null,
    anomalie_doublon_active: !!(f.doublon_potentiel && (f.statut_doublon || 'aucun') === 'potentiel'),
    incidence: true, periode_origine: `T${f.trimestre} ${f.annee}`,
  }));
  const all = list.concat(inc);
  return { periode: p, rows: all, totals: delaisTotals(all), figee };
}

// Totalisation UNIQUE de la feuille de délais — partagée par l'API JSON (écran) et par l'export
// Excel (appliquée au sous-ensemble filtré). Toute divergence de définition entre l'écran et le
// fichier est ainsi impossible : « TTC » = factures DE la période (hors incidences reportées),
// « amende » = tout ce qui est dû AU TITRE de la période (incidences comprises).
function delaisTotals(rows) {
  const propres = rows.filter(x => !x.incidence);
  const inc = rows.filter(x => x.incidence);
  const aDecl = rows.filter(x => x.a_declarer);
  return {
    count: rows.length, incidences: inc.length,
    ttc: round2(propres.reduce((s, x) => s + (x.ttc || 0), 0)),
    ttcIncidence: round2(inc.reduce((s, x) => s + (x.ttc || 0), 0)),
    aDeclarer: aDecl.length,
    ttcRetard: round2(aDecl.reduce((s, x) => s + (x.ttc || 0), 0)),
    amende: round2(rows.reduce((s, x) => s + (x.amende || 0), 0)),
    amendeIncidence: round2(inc.reduce((s, x) => s + (x.amende || 0), 0)),
    retardMoyen: aDecl.length ? Math.round(aDecl.reduce((s, x) => s + (x.retard || 0), 0) / aDecl.length) : 0,
    sansConvention: rows.filter(x => !x.has_conv && x.delai_applicable >= 120).length,
  };
}

// Filtres de la feuille de délais (mêmes critères que le frontend).
const DELAIS_FILTRES = {
  all:    { label: 'Toutes les factures',      test: () => true },
  retard: { label: 'Factures en retard',       test: r => !!r.a_declarer },
  conv:   { label: 'Convention absente',       test: r => !r.has_conv && r.delai_applicable >= 120 },
};

// INC 2.1-D (affichage seulement, calcul inchangé) : convention appliquée par le moteur (statut, LOT 4) dont les
// dates ne couvrent pas le trimestre → « appliquée hors de sa période de validité — à confirmer ».
function markHorsValidite(e, p, rows) {
  const cache = new Map();
  for (const r of rows || []) {
    if (r.source_regle !== 'convention' || !r.four_id) continue;
    if (!cache.has(r.four_id)) cache.set(r.four_id, activeConventionFor(e.id, r.four_id));
    const c = cache.get(r.four_id);
    if (c && anomalies.covers(c, p.annee, p.trimestre) === false)
      r.conv_hors_validite = { id: c.id, debut: anomalies.convStart(c), fin: c.date_fin || null };
  }
  return rows;
}
// VISA-1 : vérifications en attente d'un dossier pour un trimestre (anomalies du trimestre ou sans trimestre connu).
function pendingChecks(cabinetId, e, p) {
  const anos = anomalies.listAnomalies({ cabinetId, entrepriseId: e.id })
    .filter(a => a.annee == null || (+a.annee === +p.annee && +a.trimestre === +p.trimestre));
  const ouvertes = anos.filter(a => a.statut_calc === 'ouverte').length, aVerifier = anos.filter(a => a.statut_calc === 'a_verifier').length;
  const convManquantes = anomalies.conventionsManquantes({ cabinetId, entrepriseId: e.id }).length;
  const horsValidite = markHorsValidite(e, p, delaisData(cabinetId, e, p).rows).filter(r => r.conv_hors_validite).length;
  return { ouvertes, aVerifier, convManquantes, horsValidite, total: ouvertes + aVerifier + convManquantes + horsValidite };
}
router.get('/clients/:id/verifications', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const p = requirePeriod(req, res); if (!p) return;
  res.json(pendingChecks(req.cabinetId, e, p));
});
router.get('/clients/:id/delais', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const data = delaisData(req.cabinetId, e, p);
  markHorsValidite(e, p, data.rows);
  res.json(data);
});

// Export Excel formaté de la feuille de délais, filtré (toutes / retard / convention absente).
router.get('/clients/:id/delais/export.xlsx', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFoundText(res, 'client');
  const p = requireExportPeriod(req, res); if (!p) return;
  const filtre = DELAIS_FILTRES[req.query.filter] ? req.query.filter : 'all';
  const { rows, figee } = delaisData(req.cabinetId, e, p);
  const filtered = rows.filter(DELAIS_FILTRES[filtre].test);
  const buf = buildDelaisXlsx(e, p, filtre, filtered, figee);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="delais_${slugify(e.raison_sociale)}_T${p.trimestre}_${p.annee}_${filtre}.xlsx"`);
  auditExport(req, 'delais', 'xlsx', e, p, { filtre, nb: filtered.length, figee });
  res.send(buf);
});

// Construit un classeur Excel clair et organisé (titre, en-têtes, totaux, largeurs, formats de nombre).
function buildDelaisXlsx(e, p, filtre, rows, figee) {
  const fLabel = DELAIS_FILTRES[filtre].label;
  const dfr = iso => { if (!iso) return ''; const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };
  const DOUBLON = { potentiel: 'À vérifier', confirme: 'Confirmé', faux_positif: 'Faux positif', aucun: '' };
  const RISK = { ok: 'Normal', app: 'Approche', orange: 'Attention', red: 'Retard', dred: 'Pénalités' };
  const HEAD = ['N° facture', 'Fournisseur', 'IF fournisseur', 'ICE fournisseur', 'Nature', 'Montant TTC (DH)',
    'Date facture', 'Date paiement', 'Arrêté au', 'Délai constaté (j)', 'Délai autorisé (j)', 'Retard (j)',
    'À déclarer', 'Amende (DH)', 'Revue doublon', 'Risque', 'Incidence reportée'];
  const dataRows = rows.map(r => [
    r.numero || '', r.four || '', r.four_if || '', r.four_ice || '', r.nature || '',
    r.ttc == null ? '' : Number(r.ttc),
    dfr(r.date_facture), dfr(r.date_paiement), dfr(r.arrete_au),
    r.delai_ecoule == null ? '' : r.delai_ecoule,
    r.delai_applicable == null ? '' : r.delai_applicable,
    r.retard == null ? '' : r.retard,
    r.a_declarer ? 'Oui' : 'Non',
    r.amende ? Number(r.amende) : 0,
    DOUBLON[r.statut_doublon || 'aucun'] || '',
    RISK[r.risk] || '',
    r.incidence ? (r.periode_origine || 'Oui') : '',
  ]);
  // Totaux calculés par la MÊME fonction que l'écran (delaisTotals) : « TTC » = factures de la
  // période, hors incidences reportées — additionner ces dernières donnait un total Excel supérieur
  // au total affiché. Les incidences sont totalisées sur leur propre ligne, sans jamais disparaître.
  const T = delaisTotals(rows);
  const title = `Feuille de calcul des délais — ${e.raison_sociale}`;
  const subtitle = `Période T${p.trimestre} ${p.annee} · Filtre : ${fLabel} · ${T.count - T.incidences} facture(s) de la période`
    + (T.incidences ? ` + ${T.incidences} incidence(s) reportée(s)` : '')
    // Mention exacte : sur une période clôturée les factures DE la période sont figées ; les
    // incidences reportées restent, elles, rattachées à leur période d'origine (non figée).
    + ` · ${T.aDeclarer} en retard`
    + (figee ? ` · PÉRIODE CLÔTURÉE — valeurs figées${T.incidences ? ' (hors incidences reportées, rattachées à leur période d\'origine)' : ''}` : '')
    + ` · Édité le ${dfr(calc.iso(new Date()))}`;
  const totalRow = ['TOTAL', '', '', '', '', T.ttc, '', '', '', '', '', '', '', round2(T.amende - T.amendeIncidence), '', '', ''];
  // Les incidences reportées (factures d'un trimestre antérieur pesant encore sur celui-ci) sont
  // totalisées à part, puis cumulées : rien n'est perdu et rien n'est mélangé.
  const extra = T.incidences ? [
    ['Incidences reportées', '', '', '', '', T.ttcIncidence, '', '', '', '', '', '', '', T.amendeIncidence, '', '', `${T.incidences} ligne(s)`],
    ['TOTAL AMENDE DUE AU TITRE DE LA PÉRIODE', '', '', '', '', '', '', '', '', '', '', '', '', T.amende, '', '', ''],
  ] : [];
  const aoa = [[title], [subtitle], [], HEAD, ...dataRows, [], totalRow, ...extra];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 16 }, { wch: 30 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 9 }, { wch: 10 }, { wch: 14 }, { wch: 13 }, { wch: 11 }, { wch: 16 }];
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: HEAD.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: HEAD.length - 1 } },
  ];
  // Formats de nombre pour TTC (col 5) et Amende (col 13), en-têtes de données à partir de la ligne 5 (index 4).
  for (let r = 4; r < aoa.length; r++) {
    for (const c of [5, 13]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') { cell.t = 'n'; cell.z = '#,##0.00'; }
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Délais T${p.trimestre} ${p.annee}`.slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
router.post('/clients/:id/recompute', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  if (!assertWritable(res, req.cabinetId, e.id, p.annee, p.trimestre)) return;
  recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  audit(req.cabinetId, req.user.id, 'recalcul', 'periode', { entreprise: e.id, annee: p.annee, trimestre: p.trimestre }, req.ip);
  res.json({ ok: true });
});

/* ============================================================ REVUE DES DOUBLONS (non destructive)
 * L'utilisateur tranche une détection de doublon potentiel : « confirme » (vrai doublon gardé) ou
 * « faux_positif » (à ignorer). AUCUNE facture n'est jamais supprimée ni fusionnée : seule change
 * l'étiquette de revue. « potentiel » permet d'annuler une revue et de réactiver l'alerte.
 */
const DOUBLON_STATUTS_REVUE = new Set(['confirme', 'faux_positif', 'potentiel']);
router.patch('/clients/:id/factures/:factureId/doublon', (req, res) => {
  const e = ownedEntreprise(req, req.params.id);           // isolation tenant + appartenance client
  if (!e) return notFound(res, 'client');
  const statut = String((req.body && req.body.statut) || '').trim();
  if (!DOUBLON_STATUTS_REVUE.has(statut))
    return res.status(400).json({ error: 'Statut de revue invalide (attendu : confirme, faux_positif ou potentiel).' });
  const f = db.prepare('SELECT * FROM facture WHERE id=? AND entreprise_id=?').get(req.params.factureId, e.id);
  if (!f) return notFound(res, 'facture');
  // Période clôturée/déclarée = immuable : aucune modification de facture (revue doublon incluse).
  if (f.annee && f.trimestre && !assertWritable(res, req.cabinetId, e.id, f.annee, f.trimestre)) return;
  const avant = { statut_doublon: f.statut_doublon || 'aucun', doublon_potentiel: !!f.doublon_potentiel,
    date_revue_doublon: f.date_revue_doublon || null, utilisateur_revue_doublon: f.utilisateur_revue_doublon || null };
  // Mise à jour NON destructive : la facture reste en base et dans les calculs ; doublon_potentiel (trace) est conservé.
  db.prepare(`UPDATE facture SET statut_doublon=?, date_revue_doublon=datetime('now'), utilisateur_revue_doublon=? WHERE id=?`)
    .run(statut, req.user.id, f.id);
  // Anomalie associée : cohérente avec la décision de revue (jamais supprimée, l'historique reste).
  const ano = db.prepare(`SELECT id FROM anomalie WHERE type='doublon_potentiel' AND entite='facture' AND entite_id=?
     ORDER BY (statut='ouverte') DESC, created_at DESC LIMIT 1`).get(f.id);
  if (ano) {
    if (statut === 'potentiel') {
      // Réouverture : on réactive l'alerte (annulation d'une revue précédente).
      db.prepare(`UPDATE anomalie SET statut='ouverte', resolue_le=NULL, motif_resolution=NULL WHERE id=?`).run(ano.id);
    } else {
      const motifRes = statut === 'faux_positif' ? 'faux_positif' : 'doublon_confirme';
      db.prepare(`UPDATE anomalie SET statut='resolue', resolue_le=datetime('now'), motif_resolution=? WHERE id=?`).run(motifRes, ano.id);
    }
  }
  const upd = db.prepare('SELECT statut_doublon, date_revue_doublon, utilisateur_revue_doublon, doublon_potentiel FROM facture WHERE id=?').get(f.id);
  const apres = { statut_doublon: upd.statut_doublon, doublon_potentiel: !!upd.doublon_potentiel,
    date_revue_doublon: upd.date_revue_doublon, utilisateur_revue_doublon: upd.utilisateur_revue_doublon };
  audit(req.cabinetId, req.user.id, 'revue_doublon', 'facture', { facture: f.id, entreprise: e.id, avant, apres }, req.ip);
  res.json({ ok: true, id: f.id, statut_doublon: upd.statut_doublon, doublon_potentiel: !!upd.doublon_potentiel,
    date_revue_doublon: upd.date_revue_doublon, utilisateur_revue_doublon: upd.utilisateur_revue_doublon,
    anomalie_doublon_active: statut === 'potentiel' && !!ano });
});

/* ============================================================ FACTURE manuelle */
router.post('/clients/:id/factures', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const b = req.body || {};
  const iceN = normalizeIce(b.four_ice);
  let fId = b.fournisseur_id;
  // Un fournisseur fourni explicitement DOIT appartenir à cette entreprise (anti-IDOR).
  if (fId && !db.prepare('SELECT 1 FROM fournisseur WHERE id=? AND entreprise_id=?').get(fId, e.id))
    return res.status(400).json({ error: 'Fournisseur invalide.' });
  if (!fId) {
    let f = iceN ? db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND ice=?').get(e.id, iceN) : null;
    if (f) fId = f.id;
    else { fId = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,?,60)').run(fId, req.cabinetId, e.id, b.fournisseur || null, iceN, b.four_if || null); }
  }
  const mht = Number(b.mht) || 0, tva = Number(b.tva) || 0; let ttc = Number(b.ttc) || round2(mht + tva);
  // Délai AUTORISÉ résolu par la fonction CENTRALE (opérateur réseau 30 j → convention → standard 60 j),
  // même règle et même sélection de convention que le recalcul / la feuille de délais / l'import.
  const fRow = db.prepare('SELECT * FROM fournisseur WHERE id=?').get(fId);
  const conv = activeConventionFor(e.id, fId);
  const delai = reseau.resolveDelaiAutorise({ fournisseur: fRow, convention: conv }).delaiAutorise;
  const dpai = b.date_paiement ? calc.parseDate(b.date_paiement) : null;
  // Période cible = celle fournie (contexte), sinon dérivée du paiement, sinon la plus récente.
  const per = (b.annee && b.trimestre) ? { annee: +b.annee, trimestre: +b.trimestre } : (dpai ? { annee: dpai.getFullYear(), trimestre: calc.trimestreOf(dpai) } : latestPeriod(e.id));
  if (!assertWritable(res, req.cabinetId, e.id, per.annee, per.trimestre)) return;
  const c = calc.computeFacture({ dateFacture: b.date_facture, datePaiement: b.date_paiement, ttc, delaiApplicable: delai, periode: per, tauxProvider: (y, m) => tauxAt(y, m, req.cabinetId) });
  const id = uid('fac');
  db.prepare(`INSERT INTO facture (id,cabinet_id,entreprise_id,fournisseur_id,numero,designation,mht,tva,ttc,taux_tva,
     date_facture,date_paiement,annee,periode,trimestre,source_import,delai_applicable,delai_ecoule,date_limite,
     retard_jours,n_mois,a_declarer,taux_bam,taux_total,base_amende,montant_amende,couleur_risque)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.cabinetId, e.id, fId, b.numero || null, b.designation || null, mht, tva, ttc, Number(b.taux_tva) || null,
      calc.iso(calc.parseDate(b.date_facture)), calc.iso(dpai), per.annee, per.trimestre, per.trimestre, 'saisie',
      delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0, c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque);
  res.json({ ok: true, id, calc: c });
});

/* ============================================================ IMPORT (upload) */
router.post('/clients/:id/import', heavyLimiter, upload.array('files', 30), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) { cleanupUploads(req); return notFound(res, 'client'); }
  const files = req.files || (req.file ? [req.file] : []);
  if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  // Contexte période OBLIGATOIRE et validé serveur (isolation stricte par trimestre).
  const per = requirePeriod(req, res); if (!per) { files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} }); return; }
  if (!assertWritable(res, req.cabinetId, e.id, per.annee, per.trimestre)) { files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} }); return; }
  const crypto = require('crypto');
  const out = [];
  for (const file of files) {
    try {
      const buf = fs.readFileSync(file.path);
      const empreinte = crypto.createHash('sha256').update(buf).digest('hex');
      const r = importWorkbook(buf, { cabinetId: req.cabinetId, entrepriseId: e.id, sourceName: file.originalname, periode: per });
      const stored = r.importId + '__' + (file.originalname || 'fichier').replace(/[^\w.\-]/g, '_');
      try { fs.renameSync(file.path, path.join(UP_DIR, stored)); } catch (_) { fs.copyFileSync(file.path, path.join(UP_DIR, stored)); fs.unlink(file.path, () => {}); }
      // Lot d'import (id = importId, cohérent avec la migration) rattaché à la période.
      db.prepare(`INSERT INTO import_lot (id,cabinet_id,entreprise_id,document_id,annee,trimestre,source_nom,statut,nb_lignes_valides,nb_doublons,total_ttc,empreinte_fichier,utilisateur_id,confirmed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
        .run(r.importId, req.cabinetId, e.id, null, per.annee, per.trimestre, file.originalname, 'confirme', r.imported, r.duplicates, r.totals.ttc, empreinte, req.user.id);
      const docId = uid('doc');
      db.prepare(`INSERT INTO document (id,cabinet_id,entreprise_id,type,nom,chemin,taille,mime,import_id,nb_factures,annee,trimestre,import_lot_id,empreinte,utilisateur_id,statut)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(docId, req.cabinetId, e.id, 'import', file.originalname, stored, file.size, file.mimetype, r.importId, r.imported, per.annee, per.trimestre, r.importId, empreinte, req.user.id, 'traite');
      db.prepare('UPDATE import_lot SET document_id=? WHERE id=?').run(docId, r.importId);
      // Traçabilité période/origine sur les factures du lot.
      db.prepare('UPDATE facture SET import_lot_id=? WHERE entreprise_id=? AND import_id=?').run(r.importId, e.id, r.importId);
      db.prepare(`UPDATE facture SET annee_origine=CAST(substr(date_facture,1,4) AS INTEGER),
                  trimestre_origine=((CAST(substr(date_facture,6,2) AS INTEGER)-1)/3)+1
                  WHERE entreprise_id=? AND import_id=? AND date_facture IS NOT NULL AND annee_origine IS NULL`).run(e.id, r.importId);
      audit(req.cabinetId, req.user.id, 'import', 'facture', { file: file.originalname, imported: r.imported, annee: per.annee, trimestre: per.trimestre }, req.ip);
      out.push({ file: file.originalname, ok: true, format: r.format, imported: r.imported, duplicates: r.duplicates, fournisseursCreated: r.fournisseursCreated, anomalies: r.anomalies, totals: r.totals, importId: r.importId });
    } catch (err) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      out.push({ file: file.originalname, ok: false, error: err.message });
    }
  }
  const agg = out.reduce((a, r) => r.ok ? { imported: a.imported + r.imported, duplicates: a.duplicates + r.duplicates, fournisseursCreated: a.fournisseursCreated + r.fournisseursCreated, anomalies: a.anomalies + r.anomalies.length, amende: round2(a.amende + r.totals.amende), aDeclarer: a.aDeclarer + r.totals.aDeclarer } : a,
    { imported: 0, duplicates: 0, fournisseursCreated: 0, anomalies: 0, amende: 0, aDeclarer: 0 });
  res.json({ ok: true, files: out, agg, periode: per });
});

/* ============================================================ ASSISTANT D'IMPORT (wizard) */
const importer = require('./importer');
function safeUploadPath(token, req) {
  const base = path.basename(String(token || ''));            // anti path-traversal
  if (!base || base.includes('/') || base.includes('\\')) return null;
  // Jeton LIÉ à l'espace qui l'a créé : seul un fichier temporaire de CE cabinet est accepté
  // (jamais un fichier d'un autre espace ni un document archivé).
  if (!req || !base.startsWith(`tmp_${req.cabinetId}_`)) return null;
  const p = path.join(UP_DIR, base);
  return fs.existsSync(p) ? p : null;
}
// Étape 2 — analyse du fichier (stocke un fichier temporaire, renvoie un token).
router.post('/clients/:id/import/analyze', upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return notFound(res, 'client'); }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  try {
    const buf = fs.readFileSync(req.file.path);
    const token = `tmp_${req.cabinetId}_` + path.basename(req.file.path);
    fs.renameSync(req.file.path, path.join(UP_DIR, token));
    const kind = (req.body && req.body.kind === 'conventions') ? 'conventions' : 'factures';
    const analyse = importer.analyzeWorkbook(buf, kind);
    audit(req.cabinetId, req.user.id, 'import_analyse', 'import', { file: req.file.originalname, entreprise: e.id, kind }, req.ip);
    res.json({ ...analyse, token, sourceName: req.file.originalname, taille: req.file.size });
  } catch (err) { try { fs.unlinkSync(req.file.path); } catch (_) {} res.status(400).json({ error: err.message }); }
});
// Étape 4 — prévisualisation (aucune écriture).
router.post('/clients/:id/import/preview', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const b = req.body || {};
  const p = requirePeriod(req, res); if (!p) return;
  const tmp = safeUploadPath(b.token, req); if (!tmp) return res.status(400).json({ error: 'Le fichier analysé n’est plus disponible (analyse trop ancienne ou page rechargée). Relancez l’analyse du fichier : rien n’a été importé.', code: 'analyse_expiree' });
  try {
    const out = importer.previewImport(fs.readFileSync(tmp), {
      sheetName: b.sheetName, headerRow: b.headerRow, mapping: b.mapping || {},
      cabinetId: req.cabinetId, entrepriseId: e.id, annee: p.annee, trimestre: p.trimestre, requireNumero: !!b.requireNumero,
    });
    // Contrôle hors trimestre : critère du moteur (date de paiement), pas la date de facture (ANO-7).
    Object.assign(out.stats, periodCheck.periodCounts(fs.readFileSync(tmp), b, p.annee, p.trimestre));
    res.json(out);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Étape 5 — confirmation (écrit en transaction).
router.post('/clients/:id/import/confirm', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const b = req.body || {};
  const p = requirePeriod(req, res); if (!p) return;
  if (!assertWritable(res, req.cabinetId, e.id, p.annee, p.trimestre)) return;
  const tmp = safeUploadPath(b.token, req); if (!tmp) return res.status(400).json({ error: 'Le fichier analysé n’est plus disponible (analyse trop ancienne ou page rechargée). Relancez l’analyse du fichier : rien n’a été importé.', code: 'analyse_expiree' });
  // Contrôle de rattachement EXPLICITE (demandé par l'interface via strictPeriode ; l'API historique est
  // inchangée) : des lignes datées hors du trimestre choisi ne sont jamais rattachées sans confirmation.
  if (b.strictPeriode && !b.accepteHorsPeriode) {
    try {
      const pv = importer.previewImport(fs.readFileSync(tmp), { sheetName: b.sheetName, headerRow: b.headerRow, mapping: b.mapping || {},
        cabinetId: req.cabinetId, entrepriseId: e.id, annee: p.annee, trimestre: p.trimestre, requireNumero: !!b.requireNumero });
      const st = { ...(pv.stats || {}), ...periodCheck.periodCounts(fs.readFileSync(tmp), b, p.annee, p.trimestre) };
      if (st.autrePeriode > 0) return res.status(409).json({ code: 'hors_periode', autrePeriode: st.autrePeriode, memePeriode: st.memePeriode, valides: st.valides,
        error: `${st.autrePeriode} ligne(s) ne relèvent pas de T${p.trimestre} ${p.annee} (paiement hors du trimestre, ou facture postérieure s'il n'y a pas de paiement). Vérifiez le trimestre choisi ou confirmez explicitement leur rattachement. Aucune facture n'a été enregistrée.` });
    } catch (err) { return res.status(400).json({ error: err.message }); }
  }
  try {
    const buf = fs.readFileSync(tmp);
    const crypto = require('crypto');
    const empreinte = crypto.createHash('sha256').update(buf).digest('hex');
    const sourceName = b.sourceName || 'import.xlsx';
    const r = importer.confirmImport(buf, {
      sheetName: b.sheetName, headerRow: b.headerRow, mapping: b.mapping || {},
      cabinetId: req.cabinetId, entrepriseId: e.id, annee: p.annee, trimestre: p.trimestre,
      requireNumero: !!b.requireNumero, sourceName, userId: req.user.id, empreinte,
    });
    // Déplace le fichier temporaire en permanent + crée le document rattaché à la période.
    const stored = r.importId + '__' + sourceName.replace(/[^\w.\-]/g, '_');
    try { fs.renameSync(tmp, path.join(UP_DIR, stored)); } catch (_) { try { fs.copyFileSync(tmp, path.join(UP_DIR, stored)); fs.unlinkSync(tmp); } catch (_) {} }
    const docId = uid('doc');
    db.prepare(`INSERT INTO document (id,cabinet_id,entreprise_id,type,nom,chemin,taille,mime,import_id,nb_factures,annee,trimestre,import_lot_id,empreinte,utilisateur_id,statut)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(docId, req.cabinetId, e.id, 'import', sourceName, stored, 0, null, r.importId, r.imported, p.annee, p.trimestre, r.importId, empreinte, req.user.id, 'traite');
    db.prepare('UPDATE import_lot SET document_id=? WHERE id=?').run(docId, r.importId);
    audit(req.cabinetId, req.user.id, 'import_confirme', 'import', { importId: r.importId, imported: r.imported, annee: p.annee, trimestre: p.trimestre, file: sourceName }, req.ip);
    res.json({ ok: true, ...r });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Rapport des lignes (ignorées/rejetées/doublons/valides) d'un import.
router.get('/imports/:importId/rejections', (req, res) => {
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=?').get(req.params.importId, req.cabinetId);
  if (!lot) return notFound(res, 'import');
  const rows = db.prepare(`SELECT numero_ligne, feuille, statut, motif, champ, donnees_brutes_json FROM import_ligne
    WHERE import_lot_id=? AND statut IN ('ignoree','rejetee','doublon') ORDER BY numero_ligne`).all(lot.id);
  res.json({ importId: lot.id, source: lot.source_nom, lignes: rows.map(r => ({ ...r, brut: JSON.parse(r.donnees_brutes_json || '[]') })) });
});
router.get('/imports/:importId/rejections.csv', (req, res) => {
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=?').get(req.params.importId, req.cabinetId);
  if (!lot) return notFoundText(res, 'import');
  const rows = db.prepare(`SELECT numero_ligne, feuille, statut, motif, champ, donnees_brutes_json FROM import_ligne
    WHERE import_lot_id=? AND statut IN ('ignoree','rejetee','doublon') ORDER BY numero_ligne`).all(lot.id);
  // Toutes les cellules passent par csvCell : les valeurs viennent d'un classeur téléversé (nom de
  // feuille, contenu brut) — sans échappement, un « ; » dans un nom de feuille décalait les colonnes
  // et un contenu commençant par « = » restait exécutable à l'ouverture dans Excel.
  let csv = 'Ligne;Feuille;Statut;Motif;Champ;Donnees\n';
  for (const r of rows)
    csv += [r.numero_ligne, r.feuille || '', r.statut, r.motif || '', r.champ || '',
      String(r.donnees_brutes_json || '').replace(/[\r\n]+/g, ' ').slice(0, 300)].map(csvCell).join(';') + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rejets_${lot.id}.csv"`);
  auditExport(req, 'rejets_import', 'csv', null, { annee: lot.annee, trimestre: lot.trimestre }, { importId: lot.id, source: lot.source_nom, nb: rows.length });
  res.send('﻿' + csv);
});

/* ============================================================ MODÈLES DE MAPPING */
router.get('/mapping-templates', (req, res) => {
  const type = req.query.type;
  const rows = type
    ? db.prepare('SELECT * FROM modele_mapping WHERE cabinet_id=? AND type_fichier=? ORDER BY derniere_utilisation DESC, created_at DESC').all(req.cabinetId, type)
    : db.prepare('SELECT * FROM modele_mapping WHERE cabinet_id=? ORDER BY derniere_utilisation DESC, created_at DESC').all(req.cabinetId);
  res.json(rows.map(r => ({ ...r, mapping: JSON.parse(r.mapping_json || '{}'), transformations: JSON.parse(r.transformations_json || '{}') })));
});
router.post('/mapping-templates', (req, res) => {
  const b = req.body || {};
  if (!b.nom) return res.status(400).json({ error: 'Nom du modèle requis.' });
  const id = uid('map');
  db.prepare(`INSERT INTO modele_mapping (id,cabinet_id,nom,type_fichier,signature_colonnes,feuille,ligne_entete,mapping_json,transformations_json,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.cabinetId, b.nom, b.type_fichier || null, b.signature_colonnes || null, b.feuille || null, b.ligne_entete != null ? +b.ligne_entete : null,
      JSON.stringify(b.mapping || {}), JSON.stringify(b.transformations || {}), req.user.id);
  audit(req.cabinetId, req.user.id, 'create', 'modele_mapping', { id, nom: b.nom }, req.ip);
  res.json({ ok: true, id });
});
router.put('/mapping-templates/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM modele_mapping WHERE id=? AND cabinet_id=?').get(req.params.id, req.cabinetId);
  if (!m) return notFound(res, 'modele');
  const b = req.body || {};
  db.prepare(`UPDATE modele_mapping SET nom=?, type_fichier=?, signature_colonnes=?, feuille=?, ligne_entete=?, mapping_json=?, transformations_json=?, updated_at=datetime('now'), derniere_utilisation=datetime('now') WHERE id=?`)
    .run(b.nom ?? m.nom, b.type_fichier ?? m.type_fichier, b.signature_colonnes ?? m.signature_colonnes, b.feuille ?? m.feuille,
      b.ligne_entete != null ? +b.ligne_entete : m.ligne_entete, JSON.stringify(b.mapping || JSON.parse(m.mapping_json || '{}')),
      JSON.stringify(b.transformations || JSON.parse(m.transformations_json || '{}')), m.id);
  res.json({ ok: true });
});
router.delete('/mapping-templates/:id', (req, res) => {
  const m = db.prepare('SELECT id FROM modele_mapping WHERE id=? AND cabinet_id=?').get(req.params.id, req.cabinetId);
  if (!m) return notFound(res, 'modele');
  db.prepare('DELETE FROM modele_mapping WHERE id=?').run(m.id);
  res.json({ ok: true });
});

router.get('/clients/:id/documents', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  // Isolation : si une période est fournie, ne renvoyer QUE ses fichiers.
  const p = readPeriodParams(req);
  const rows = p
    ? db.prepare(`SELECT id, type, nom, taille, mime, import_id, import_lot_id, nb_factures, annee, trimestre, created_at FROM document WHERE entreprise_id=? AND type='import' AND annee=? AND trimestre=? ORDER BY created_at DESC`).all(e.id, p.annee, p.trimestre)
    : db.prepare(`SELECT id, type, nom, taille, mime, import_id, import_lot_id, nb_factures, annee, trimestre, created_at FROM document WHERE entreprise_id=? AND type='import' ORDER BY created_at DESC`).all(e.id);
  res.json(rows);
});
router.get('/clients/:id/documents/:docId/download', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFoundText(res, 'client');
  const doc = db.prepare('SELECT * FROM document WHERE id=? AND entreprise_id=?').get(req.params.docId, e.id);
  if (!doc || !doc.chemin) return notFoundText(res, 'fichier');
  res.download(path.join(UP_DIR, doc.chemin), doc.nom || 'fichier');
});
router.delete('/clients/:id/documents/:docId', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const doc = db.prepare('SELECT * FROM document WHERE id=? AND entreprise_id=?').get(req.params.docId, e.id);
  if (!doc) return notFound(res, 'fichier');
  // Interdit si la période du document est clôturée/déclarée.
  if (doc.annee && doc.trimestre && !assertWritable(res, req.cabinetId, e.id, doc.annee, doc.trimestre)) return;
  let removed = 0;
  if (doc.import_id) removed = db.prepare('DELETE FROM facture WHERE entreprise_id=? AND import_id=?').run(e.id, doc.import_id).changes;
  db.prepare('DELETE FROM document WHERE id=?').run(doc.id);
  if (doc.chemin) try { fs.unlinkSync(path.join(UP_DIR, doc.chemin)); } catch (_) {}
  audit(req.cabinetId, req.user.id, 'delete', 'document', { nom: doc.nom, factures: removed }, req.ip);
  res.json({ ok: true, facturesSupprimees: removed });
});
// Détail d'un lot d'import (cloisonné cabinet).
router.get('/imports/:importId', (req, res) => {
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=?').get(req.params.importId, req.cabinetId);
  if (!lot) return notFound(res, 'import');
  const nbFac = db.prepare('SELECT COUNT(*) n FROM facture WHERE import_id=?').get(lot.id).n;
  res.json({ ...lot, factures_actuelles: nbFac });
});
// Aperçu des conséquences d'une annulation (avant confirmation).
router.get('/clients/:id/import/:importId/impact', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=? AND entreprise_id=?').get(req.params.importId, req.cabinetId, e.id);
  if (!lot) return notFound(res, 'import');
  const agg = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(ttc),0) ttc FROM facture WHERE entreprise_id=? AND import_id=?').get(e.id, lot.id);
  const decl = db.prepare('SELECT COUNT(*) n FROM declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(e.id, lot.annee, lot.trimestre).n;
  const pr = ensurePeriode(req.cabinetId, e.id, lot.annee, lot.trimestre);
  res.json({ importId: lot.id, annee: lot.annee, trimestre: lot.trimestre, factures: agg.n, total_ttc: round2(agg.ttc),
    declarations_affectees: decl, periode_statut: pr.statut, verrouillee: periode.isLocked(pr.statut) });
});
// Annulation atomique d'un import : retire UNIQUEMENT ses factures + anomalies. Réversibilité.
router.post('/clients/:id/import/:importId/cancel', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=? AND entreprise_id=?').get(req.params.importId, req.cabinetId, e.id);
  if (!lot) return notFound(res, 'import');
  if (lot.annee && lot.trimestre && !assertWritable(res, req.cabinetId, e.id, lot.annee, lot.trimestre)) return;
  let removed = 0;
  db.exec('BEGIN');
  try {
    removed = db.prepare('DELETE FROM facture WHERE entreprise_id=? AND import_id=?').run(e.id, lot.id).changes;
    db.prepare('DELETE FROM anomalie WHERE entreprise_id=? AND import_lot_id=?').run(e.id, lot.id);
    db.prepare('DELETE FROM import_ligne WHERE import_lot_id=?').run(lot.id);
    db.prepare(`UPDATE import_lot SET statut='annule', cancelled_at=datetime('now') WHERE id=?`).run(lot.id);
    db.prepare(`UPDATE document SET statut='annule' WHERE import_id=? AND entreprise_id=?`).run(lot.id, e.id);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Annulation échouée : ' + err.message }); }
  audit(req.cabinetId, req.user.id, 'annulation_import', 'import', { importId: lot.id, factures: removed, annee: lot.annee, trimestre: lot.trimestre }, req.ip);
  res.json({ ok: true, facturesSupprimees: removed });
});

router.delete('/clients/:id/conventions/:convId', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND entreprise_id=?').get(req.params.convId, e.id);
  if (!c) return notFound(res, 'convention');
  db.prepare('DELETE FROM convention WHERE id=?').run(c.id);
  if (c.fichier) try { fs.unlinkSync(path.join(UP_DIR, c.fichier)); } catch (_) {}
  if (c.fournisseur_id) {
    const rest = db.prepare(`SELECT COUNT(*) n FROM convention WHERE fournisseur_id=? AND statut='valide'`).get(c.fournisseur_id).n;
    if (!rest) db.prepare('UPDATE fournisseur SET delai_applicable=60 WHERE id=?').run(c.fournisseur_id);
  }
  // Recalcul de toutes les périodes NON clôturées du fournisseur concerné.
  if (c.fournisseur_id) recomputeOpenPeriodsForFournisseurs(req.cabinetId, e.id, [c.fournisseur_id]);
  else { const p = latestPeriod(e.id); recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre); }
  // Trace « avant » complète (Phase 5 — comprendre exactement ce qui a été retiré).
  audit(req.cabinetId, req.user.id, 'delete', 'convention',
    { id: c.id, entreprise: e.id, fournisseur: c.fournisseur_id, delai_convenu: c.delai_convenu,
      date_debut: c.date_debut, date_fin: c.date_fin, avait_document: !!c.fichier }, req.ip);
  res.json({ ok: true });
});

/* ============================================================ DECLARATIONS */
// IMMUABILITÉ DÉCLARATIVE (LOT 6 → LOT 7) : une période verrouillée expose la déclaration TELLE
// QU'ELLE A ÉTÉ ARRÊTÉE. `recomputePeriod` gelait déjà les factures, mais l'agrégat était refait à
// chaque lecture : l'ensemble des EXCLUSIONS réseau et l'en-tête (ca_ht / type_visa) étaient relus
// en direct → une confirmation « opérateur de réseau » ou un changement de CA POSTÉRIEURS à la
// clôture modifiaient le montant déclaré et réécrivaient la déclaration figée depuis un simple GET.
// Ici : lecture seule du snapshot stocké (declaration + ligne_declaration), aucune écriture.
function frozenDeclaration(entrepriseId, annee, trimestre) {
  const d = db.prepare('SELECT * FROM declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(entrepriseId, annee, trimestre);
  if (!d) return null;
  const lignes = db.prepare(`SELECT facture_id, fournisseur_if, fournisseur_nom, ttc, non_paye, paye_hors_delai, retard_jours, montant_amende
    FROM ligne_declaration WHERE declaration_id=? ORDER BY montant_amende DESC`).all(d.id)
    .map(l => ({ facture_id: l.facture_id, if: l.fournisseur_if, nom: l.fournisseur_nom, ttc: l.ttc,
                 non_paye: l.non_paye, hors_delai: l.paye_hors_delai, retard: l.retard_jours, amende: l.montant_amende }));
  // Exclusions reconstituées depuis le snapshot : factures à déclarer de la période ABSENTES du
  // tableau figé = celles qui en ont été écartées au moment de l'arrêté (aucune relecture live).
  const retenues = new Set(lignes.map(l => l.facture_id));
  const exclues = db.prepare(`SELECT f.id, f.ttc, f.montant_amende, f.fournisseur_id FROM facture f
    WHERE f.entreprise_id=? AND f.annee=? AND f.trimestre=? AND f.a_declarer=1`).all(entrepriseId, annee, trimestre)
    .filter(f => !retenues.has(f.id));
  const exclusions = {
    nbFactures: exclues.length,
    ttc: round2(exclues.reduce((s, f) => s + (f.ttc || 0), 0)),
    amende: round2(exclues.reduce((s, f) => s + (f.montant_amende || 0), 0)),
    nbFournisseurs: new Set(exclues.map(f => f.fournisseur_id)).size,
    motif: reseau.MOTIF_RESEAU,
  };
  return { declaration: d, lignes, exclusions, figee: true };
}
function buildDeclaration(cabinetId, entreprise, annee, trimestre) {
  const pr = db.prepare('SELECT statut FROM periode_declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(entreprise.id, annee, trimestre);
  if (pr && periode.isLocked(pr.statut)) {
    const snap = frozenDeclaration(entreprise.id, annee, trimestre);
    if (snap) return snap;   // sinon (période verrouillée sans déclaration arrêtée) : on la construit une fois, puis elle est figée.
  }
  recomputePeriod(cabinetId, entreprise.id, annee, trimestre);
  const allFacs = db.prepare(`SELECT f.*, fo.raison_sociale four_nom, fo.if_fiscal four_if,
       fo.operateur_reseau, fo.statut_classification, fo.hors_tableau_declaratif, fo.categorie_fournisseur
     FROM facture f LEFT JOIN fournisseur fo ON fo.id=f.fournisseur_id
     WHERE f.entreprise_id=? AND f.annee=? AND f.trimestre=? AND f.a_declarer=1
     ORDER BY f.montant_amende DESC`).all(entreprise.id, annee, trimestre);
  // EXCLUSION DÉCLARATIVE explicite et tracée des opérateurs de réseau CONFIRMÉS (jamais supprimées).
  const facs = [], exclues = [];
  for (const f of allFacs) (reseau.estHorsTableauDeclaratif(f) ? exclues : facs).push(f);
  const excludedFournisseurs = new Set(exclues.map(f => f.fournisseur_id));
  const exclusions = {
    nbFactures: exclues.length,
    ttc: round2(exclues.reduce((s, f) => s + (f.ttc || 0), 0)),
    amende: round2(exclues.reduce((s, f) => s + (f.montant_amende || 0), 0)),
    nbFournisseurs: excludedFournisseurs.size,
    motif: reseau.MOTIF_RESEAU,
  };
  const tot = { ttc: 0, nonPaye: 0, horsDelai: 0, amende: 0, litiges: 0 };
  const lignes = facs.map(f => {
    const nonPaye = f.date_paiement ? 0 : f.ttc, hors = f.date_paiement ? f.ttc : 0;
    tot.ttc = round2(tot.ttc + f.ttc); tot.nonPaye = round2(tot.nonPaye + nonPaye);
    tot.horsDelai = round2(tot.horsDelai + hors); tot.amende = round2(tot.amende + (f.montant_amende || 0));
    return { facture_id: f.id, if: f.four_if, nom: f.four_nom, ttc: f.ttc, non_paye: nonPaye, hors_delai: hors, retard: f.retard_jours, amende: f.montant_amende };
  });
  let d = db.prepare('SELECT * FROM declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(entreprise.id, annee, trimestre);
  const montantAVerser = round2(tot.amende + (d ? d.sanctions_retard : 0));
  if (!d) {
    const id = uid('decl');
    db.prepare(`INSERT INTO declaration (id,cabinet_id,entreprise_id,annee,trimestre,ca_ht,type_visa,
        montant_total_ttc,montant_non_paye,montant_paye_hors_delai,montant_total_amende,montant_litiges,
        sanctions_retard,montant_a_verser,nb_lignes,date_edition,statut)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, cabinetId, entreprise.id, annee, trimestre, entreprise.ca_ht, visaOf(entreprise.ca_ht),
        tot.ttc, tot.nonPaye, tot.horsDelai, tot.amende, tot.litiges, 0, montantAVerser, lignes.length,
        calc.iso(new Date()), 'brouillon');
    d = db.prepare('SELECT * FROM declaration WHERE id=?').get(id);
  } else {
    db.prepare(`UPDATE declaration SET ca_ht=?, type_visa=?, montant_total_ttc=?, montant_non_paye=?,
        montant_paye_hors_delai=?, montant_total_amende=?, montant_a_verser=?, nb_lignes=?, date_edition=? WHERE id=?`)
      .run(entreprise.ca_ht, visaOf(entreprise.ca_ht), tot.ttc, tot.nonPaye, tot.horsDelai, tot.amende,
        montantAVerser, lignes.length, calc.iso(new Date()), d.id);
    d = db.prepare('SELECT * FROM declaration WHERE id=?').get(d.id);
  }
  db.prepare('DELETE FROM ligne_declaration WHERE declaration_id=?').run(d.id);
  const ins = db.prepare(`INSERT INTO ligne_declaration (id,declaration_id,facture_id,fournisseur_if,fournisseur_nom,ttc,non_paye,paye_hors_delai,retard_jours,montant_amende) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const l of lignes) ins.run(uid('lgn'), d.id, l.facture_id, l.if, l.nom, l.ttc, l.non_paye, l.hors_delai, l.retard, l.amende);
  return { declaration: d, lignes, exclusions, figee: false };
}
router.get('/clients/:id/declaration', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { declaration, lignes, exclusions, figee } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  // Sur une période figée, l'en-tête affiché est celui ARRÊTÉ (CA / type de visa), pas la valeur courante.
  res.json({ entreprise: shapeEnt(e, figee ? declaration : null), declaration, lignes, exclusions, figee: !!figee });
});
function shapeEnt(e, fige) {
  return { id: e.id, raison_sociale: e.raison_sociale, ice: e.ice, if_fiscal: e.if_fiscal, rc: e.rc,
    adresse: e.adresse, ville: e.ville, secteur: e.secteur,
    ca_ht: fige ? fige.ca_ht : e.ca_ht, type_visa: fige ? fige.type_visa : visaOf(e.ca_ht) };
}

// Montants des livrables : TOUJOURS 2 décimales, point décimal (format d'échange, indépendant de la
// locale). Sans cela un TTC brut « 1234.567 » partait dans le fichier alors que l'écran et le
// récapitulatif affichent 1 234,57 → la somme des lignes ne retombait pas sur le total déclaré.
function money2(n) { return round2(Number(n) || 0).toFixed(2); }

router.get('/clients/:id/declaration/export.csv', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFoundText(res, 'client');
  const p = requireExportPeriod(req, res); if (!p) return;
  const { declaration, lignes, exclusions, figee } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  // Colonnes historiques conservées DANS LE MÊME ORDRE (aucun consommateur cassé) ; année et
  // trimestre ajoutés en fin de ligne pour qu'un fichier détaché de son nom reste non ambigu.
  let csv = 'IF fournisseur;Raison sociale;Montant TTC;Non payees;Paye hors delai;Retard (j);Amende;Annee;Trimestre\n';
  for (const l of lignes)
    csv += `${csvCell(l.if)};${csvCell(l.nom)};${money2(l.ttc)};${money2(l.non_paye)};${money2(l.hors_delai)};${l.retard == null ? '' : l.retard};${money2(l.amende)};${p.annee};${p.trimestre}\n`;
  // Total : même valeurs que le pied de tableau de l'écran.
  csv += `TOTAL;${lignes.length} ligne(s);${money2(declaration.montant_total_ttc)};${money2(declaration.montant_non_paye)};${money2(declaration.montant_paye_hors_delai)};;${money2(declaration.montant_total_amende)};${p.annee};${p.trimestre}\n`;
  // EXCLUSIONS RÉSEAU : jamais silencieuses — le fichier dit ce qui a été écarté et pourquoi.
  if (exclusions && exclusions.nbFactures)
    csv += `EXCLUSIONS RESEAU;${csvCell(exclusions.motif)};${money2(exclusions.ttc)};;;;${money2(exclusions.amende)};${p.annee};${p.trimestre}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="declaration_${p.annee}_T${p.trimestre}.csv"`);
  auditExport(req, 'declaration', 'csv', e, p, { nb: lignes.length, exclues: exclusions ? exclusions.nbFactures : 0, figee: !!figee });
  res.send('﻿' + csv);
});
router.get('/clients/:id/declaration/export.xml', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFoundText(res, 'client');
  const p = requireExportPeriod(req, res); if (!p) return;
  const { declaration, lignes, exclusions, figee } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  // En-tête du déclarant : sur une période figée, le CA arrêté (pas la valeur courante de la fiche).
  const caHt = figee ? declaration.ca_ht : e.ca_ht;
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<DeclarationDelaisPaiement annee="${p.annee}" periode="T${p.trimestre}">\n`;
  xml += `  <Declarant><RaisonSociale>${esc(e.raison_sociale)}</RaisonSociale><IF>${esc(e.if_fiscal)}</IF><ICE>${esc(e.ice)}</ICE><RC>${esc(e.rc)}</RC><CAHT>${money2(caHt)}</CAHT></Declarant>\n  <Factures>\n`;
  for (const l of lignes) xml += `    <Facture><IFFournisseur>${esc(l.if)}</IFFournisseur><RaisonSociale>${esc(l.nom)}</RaisonSociale><MontantTTC>${money2(l.ttc)}</MontantTTC><NonPaye>${money2(l.non_paye)}</NonPaye><PayeHorsDelai>${money2(l.hors_delai)}</PayeHorsDelai><Retard>${l.retard == null ? '' : l.retard}</Retard><Amende>${money2(l.amende)}</Amende></Facture>\n`;
  xml += `  </Factures>\n`;
  // Exclusions réseau tracées dans le flux (élément additif : un lecteur existant l'ignore).
  xml += `  <Exclusions nb="${exclusions ? exclusions.nbFactures : 0}" nbFournisseurs="${exclusions ? exclusions.nbFournisseurs : 0}">`
    + `<MontantTTC>${money2(exclusions ? exclusions.ttc : 0)}</MontantTTC><Amende>${money2(exclusions ? exclusions.amende : 0)}</Amende>`
    + `<Motif>${esc(exclusions ? exclusions.motif : '')}</Motif></Exclusions>\n`;
  xml += `  <Recapitulatif><NbLignes>${lignes.length}</NbLignes><TotalTTC>${money2(declaration.montant_total_ttc)}</TotalTTC><TotalAmende>${money2(declaration.montant_total_amende)}</TotalAmende><MontantAVerser>${money2(declaration.montant_a_verser)}</MontantAVerser><TypeVisa>${esc(declaration.type_visa)}</TypeVisa><PeriodeFigee>${figee ? 'oui' : 'non'}</PeriodeFigee></Recapitulatif>\n</DeclarationDelaisPaiement>\n`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="EDI_${p.annee}_T${p.trimestre}.xml"`);
  auditExport(req, 'declaration', 'xml', e, p, { nb: lignes.length, exclues: exclusions ? exclusions.nbFactures : 0, figee: !!figee });
  res.send(xml);
});

/* ============================================================ VISA */
const VISA_CONCLUSIONS = ['Sans observation', 'Avec observation', 'Avec réserve', 'Refus de visa'];
function visaData(req, e) {
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { declaration } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  // VISA-1 : aucune conclusion par défaut — choix explicite parmi les quatre conclusions du modèle.
  const conclusion = VISA_CONCLUSIONS.includes(req.query.conclusion) ? req.query.conclusion : null;
  const signataire = req.query.signataire || (db.prepare('SELECT nom FROM utilisateur WHERE id=?').get(req.user.id) || {}).nom || 'Le professionnel';
  const data = conclusion ? visa.buildData({ e, annee: p.annee, trimestre: p.trimestre, montant: declaration.montant_total_ttc, conclusion, signataire, type: visaOf(e.ca_ht) }) : null;
  return { p, declaration, data, conclusion, signataire };
}
router.get('/clients/:id/visa', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFound(res, 'client');
  const { p, declaration, data, signataire } = visaData(req, e);
  const verifications = pendingChecks(req.cabinetId, e, p);
  if (!data) return res.json({ choix_requis: true, conclusions: VISA_CONCLUSIONS, verifications, periode: p, signataire, type: visaOf(e.ca_ht),
    montant_vise: declaration.montant_total_ttc, montant_amende: declaration.montant_total_amende });
  res.json({
    verifications, conclusions: VISA_CONCLUSIONS,
    type: data.type, typeLabel: data.typeLabel, periode: p,
    montant_vise: declaration.montant_total_ttc, montant_amende: declaration.montant_total_amende,
    conclusion: data.conclusion, signataire: data.signataire, reference: 'Article 2.78 · Directive OEC du 06/10/2024',
    lieu: data.lieu, date: data.date, debut: data.debut, fin: data.fin, blocks: data.blocks,
  });
});
router.get('/clients/:id/visa/export.docx', asyncHandler(async (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFoundText(res, 'client');
  if (!requireExportPeriod(req, res)) return;
  const { p, declaration, data } = visaData(req, e);
  if (!data) return res.status(400).type('text/plain; charset=utf-8').send('Choisissez explicitement la conclusion du visa (sans observation, avec observation, avec réserve ou refus) avant de l’exporter.');
  const buf = await visa.toDocx(data.blocks);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="Visa_${slugify(e.raison_sociale)}_T${p.trimestre}_${p.annee}.docx"`);
  auditExport(req, 'visa', 'docx', e, p, { type: data.type, montant_vise: declaration.montant_total_ttc, conclusion: data.conclusion });
  res.send(buf);
}));
router.get('/clients/:id/visa/export.pdf', (req, res, next) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return notFoundText(res, 'client');
  if (!requireExportPeriod(req, res)) return;
  const { p, declaration, data } = visaData(req, e);
  if (!data) return res.status(400).type('text/plain; charset=utf-8').send('Choisissez explicitement la conclusion du visa (sans observation, avec observation, avec réserve ou refus) avant de l’exporter.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Visa_${slugify(e.raison_sociale)}_T${p.trimestre}_${p.annee}.pdf"`);
  auditExport(req, 'visa', 'pdf', e, p, { type: data.type, montant_vise: declaration.montant_total_ttc, conclusion: data.conclusion });
  try {
    const doc = visa.toPdf(data.blocks, res);
    if (doc && doc.on) doc.on('error', next);
  } catch (err) { next(err); }
});

/* ============================================================ ALERTES / ANOMALIES */
router.get('/alerts', (req, res) => {
  const cid = req.cabinetId; const out = [];
  // Conventions manquantes — définition unique (src/anomalies.js), sans limite.
  for (const r of anomalies.conventionsManquantes({ cabinetId: cid }))
    out.push({ type: 'convention', gravite: 'moyenne', titre: 'Convention manquante', message: `${r.four} — délai de ${r.delai} j appliqué sans convention enregistrée (${r.ent}) : ${r.nb} facture(s).`, date: 'Détecté à l\'import', ent_id: r.ent_id });
  // Anomalies À TRAITER (ouvertes + à vérifier) — même source que les compteurs ; aucune troncature.
  for (const a of anomalies.listAnomalies({ cabinetId: cid }).filter(x => x.statut_calc === 'ouverte' || x.statut_calc === 'a_verifier'))
    out.push({ type: a.type, gravite: a.gravite || 'moyenne', statut: a.statut_calc, titre: anomalieLabel(a.type) + (a.statut_calc === 'a_verifier' ? ' — couverte par une convention, à vérifier' : ''),
      message: a.details, date: a.created_at, ent_id: a.ent_id });
  // P3-10 : aucune échéance déclarative à annoncer tant que l'espace n'a aucun dossier client.
  const hasClients = !!db.prepare('SELECT 1 FROM entreprise WHERE cabinet_id=? LIMIT 1').get(cid);
  if (hasClients) for (const d of nextDeadlines().slice(0, 2)) out.push({ type: 'echeance', gravite: d.days <= 15 ? 'haute' : 'moyenne', titre: 'Échéance de déclaration', message: `${d.label} — dépôt SIMPL le ${d.day}/${monNum(d.mon)}.`, date: `J-${d.days}` });
  res.json({ count: out.length, alerts: out });
});
function anomalieLabel(t) { return ({ date_incoherente: 'Date incohérente', date_future: 'Date dans le futur', date_manquante: 'Date manquante', montant_incoherent: 'Montant incohérent', doublon: 'Doublon détecté', convention_absente: 'Convention absente (délai > 60 j)' })[t] || 'Anomalie'; }
function monNum(m) { return ({ Avr: '04', Jul: '07', Oct: '10', Jan: '01' })[m] || m; }

/* ============================================================ TAUX BAM */
router.get('/taux', (req, res) => {
  const rows = db.prepare(`SELECT * FROM taux_bam WHERE cabinet_id IS NULL OR cabinet_id=? ORDER BY date_debut DESC`).all(req.cabinetId);
  res.json(rows);
});
router.post('/taux', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Seul un administrateur peut modifier les taux BAM.' });
  const b = req.body || {};
  if (!b.taux || !b.date_debut) return res.status(400).json({ error: 'Taux et date de début requis.' });
  const id = uid('tx');
  db.prepare(`INSERT INTO taux_bam (id, cabinet_id, taux, date_debut, date_fin, reference) VALUES (?,?,?,?,?,?)`)
    .run(id, req.cabinetId, Number(b.taux), b.date_debut, b.date_fin || null, b.reference || null);
  audit(req.cabinetId, req.user.id, 'update', 'taux_bam', { taux: b.taux, date_debut: b.date_debut }, req.ip);
  res.json({ ok: true, id });
});

/* ============================================================ AUDIT */
router.get('/audit', (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.nom user_nom FROM audit_log a LEFT JOIN utilisateur u ON u.id=a.user_id
     WHERE a.cabinet_id=? ORDER BY a.created_at DESC LIMIT 100`).all(req.cabinetId);
  res.json(rows);
});

/* ===== vues portefeuille (cabinet-wide, pour les cartes cliquables du dashboard) ===== */
router.get('/portfolio/retards', (req, res) => {
  const rows = db.prepare(`SELECT f.id, f.numero, f.ttc, f.date_facture, f.date_paiement, f.delai_applicable,
     f.retard_jours, f.montant_amende, f.couleur_risque, f.annee, f.trimestre,
     e.id ent_id, e.raison_sociale ent, fo.raison_sociale four, fo.if_fiscal four_if
     FROM facture f JOIN entreprise e ON e.id=f.entreprise_id LEFT JOIN fournisseur fo ON fo.id=f.fournisseur_id
     WHERE f.cabinet_id=? AND f.a_declarer=1 ORDER BY f.montant_amende DESC`).all(req.cabinetId);
  res.json(rows);
});
router.get('/portfolio/conventions-manquantes', (req, res) => {
  // Même définition que tous les compteurs (src/anomalies.js — CONV-1).
  res.json(anomalies.conventionsManquantes({ cabinetId: req.cabinetId }).map(r => ({ ...r, four_id: r.id })));
});
router.get('/portfolio/conventions', (req, res) => {
  const rows = db.prepare(`SELECT c.*, e.raison_sociale ent, e.id ent_id, fo.raison_sociale four, fo.ice four_ice
     FROM convention c JOIN entreprise e ON e.id=c.entreprise_id LEFT JOIN fournisseur fo ON fo.id=c.fournisseur_id
     WHERE c.cabinet_id=? AND c.statut='valide' ORDER BY e.raison_sociale, fo.raison_sociale`).all(req.cabinetId);
  res.json(rows.map(c => ({ id: c.id, ent: c.ent, ent_id: c.ent_id, four: c.four, four_ice: c.four_ice, delai: c.delai_convenu, date_fin: c.date_fin, statut: computeConvStatut(c), fichier: c.fichier ? c.id : null })));
});
router.get('/anomalies', (req, res) => {
  const scope = { cabinetId: req.cabinetId, entrepriseId: req.query.entreprise || null };
  const rank = { ouverte: 0, a_verifier: 1, levee: 2, resolue: 3 };
  const rows = anomalies.listAnomalies(scope).sort((x, y) => rank[x.statut_calc] - rank[y.statut_calc]);
  res.json({ counts: anomalies.anomalyCounts(scope), rows });
});
router.get('/anomalies/counts', (req, res) => res.json(anomalies.anomalyCounts({ cabinetId: req.cabinetId, entrepriseId: req.query.entreprise || null })));
// Contexte d'audit COMPLET d'une anomalie (VER-2) : facture, fournisseur, type, période, convention, justificatif, auteur, horodatage.
function anoAuditCtx(req, a, extra = {}) {
  const c = a.convention || {};
  return { anomalie: a.id, type: a.type, facture: (a.facture && a.facture.numero) || a.facture_numero_directe || null, fournisseur: a.fournisseur_nom || null,
    client: a.ent || null, periode: a.annee != null ? `T${a.trimestre} ${a.annee}` : null,
    convention: c.id ? { id: c.id, delai: c.delai, date_signature: c.date_signature || null, date_effet: c.date_debut || null, date_fin: c.date_fin || null } : null,
    justificatif: c.id ? (c.justificatif ? (c.justificatif_nom || 'document joint') : null) : null,
    utilisateur: { id: req.user.id, nom: req.user.nom || null, role: req.user.role }, horodatage: new Date().toISOString(), ...extra };
}
const findAno = (req) => anomalies.listAnomalies({ cabinetId: req.cabinetId }).find(x => x.id === req.params.id);
const ANO_GONE = { error: 'Cette anomalie n’existe plus. Actualisez la page des anomalies.', code: 'anomalie_introuvable' };
const lockedMsg = (a, verbe) => ({ error: `T${a.trimestre} ${a.annee} est clôturée : l’anomalie ne peut plus être ${verbe} (lecture seule). Rouvrez la période si nécessaire.`, code: 'periode_verrouillee' });

// Valider la levée : admin ou comptable, justificatif présent, période ni clôturée ni déclarée ; signature rétroactive → accusé obligatoire.
router.post('/anomalies/:id/levee', (req, res) => {
  if (!permissions.guard(req, res, 'manage_conventions', 'Votre rôle ne permet pas de valider une levée d’anomalie.')) return;
  const a = findAno(req); if (!a) return res.status(404).json(ANO_GONE);
  if (a.periode_verrouillee) return res.status(409).json(lockedMsg(a, 'levée'));
  if (a.statut_calc !== 'a_verifier' || !a.convention) return res.status(409).json({ error: 'Aucune convention valide ne couvre le trimestre de cette anomalie : la levée est impossible.', code: 'non_couverte' });
  if (!a.convention.justificatif) return res.status(409).json({ error: 'Ajoutez d’abord le justificatif signé de la convention : une levée ne peut pas être validée sans pièce.', code: 'justificatif_manquant' });
  const b = req.body || {};
  if (a.convention.signature_retroactive && b.ackRetroactif !== true)
    return res.status(409).json({ error: 'La convention est signée après la facture ou après la fin du trimestre : cochez la case confirmant que vous avez pris connaissance de cette signature rétroactive.', code: 'ack_retroactif_requis' });
  const com = String(b.commentaire || '').trim().slice(0, 500) || null;
  db.prepare(`UPDATE anomalie SET levee_validee_le=datetime('now'), levee_validee_par=?, levee_commentaire=?, levee_convention_id=? WHERE id=? AND cabinet_id=?`)
    .run(req.user.id, com, a.convention.id, a.id, req.cabinetId);
  audit(req.cabinetId, req.user.id, 'levee_anomalie', 'anomalie', anoAuditCtx(req, a, { commentaire: com,
    signature_retroactive: !!a.convention.signature_retroactive, accuse_signature_retroactive: !!a.convention.signature_retroactive,
    avertissements: a.convention.avertissements }), req.ip);
  res.json({ ok: true });
});
// Annuler la levée : administrateur seulement, motif OBLIGATOIRE, période ni clôturée ni déclarée.
router.delete('/anomalies/:id/levee', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Seul un administrateur peut annuler une levée validée.', code: 'forbidden' });
  const a = findAno(req); if (!a) return res.status(404).json(ANO_GONE);
  if (a.periode_verrouillee) return res.status(409).json(lockedMsg(a, 'modifiée'));
  if (a.statut_calc !== 'levee') return res.status(409).json({ error: 'Cette anomalie n’est pas levée.', code: 'non_levee' });
  const motif = String((req.body && req.body.motif) || '').trim().slice(0, 500);
  if (!motif) return res.status(400).json({ error: 'Indiquez le motif de l’annulation : il est inscrit au journal d’audit.', code: 'motif_requis' });
  db.prepare(`UPDATE anomalie SET levee_validee_le=NULL, levee_validee_par=NULL, levee_commentaire=NULL, levee_convention_id=NULL WHERE id=? AND cabinet_id=?`).run(a.id, req.cabinetId);
  audit(req.cabinetId, req.user.id, 'annulation_levee', 'anomalie', anoAuditCtx(req, a, { motif,
    levee_initiale: { le: a.levee_validee_le, par: a.levee_validee_par_nom || a.levee_validee_par, commentaire: a.levee_commentaire || null } }), req.ip);
  res.json({ ok: true });
});
// Résolution manuelle (VER-1) : jamais pour « convention absente » (vérification obligatoire) ; motif, rôle, période, audit.
router.post('/anomalies/:id/resolve', (req, res) => {
  if (!permissions.guard(req, res, 'manage_conventions', 'Votre rôle ne permet pas de résoudre une anomalie.')) return;
  const a = findAno(req); if (!a) return res.status(404).json(ANO_GONE);
  if (a.type === 'convention_absente') return res.status(409).json({ error: 'Une anomalie « convention absente » ne se résout pas manuellement : enregistrez la convention datée avec son justificatif, puis validez la levée.', code: 'verification_obligatoire' });
  if (a.statut !== 'ouverte') return res.status(409).json({ error: 'Cette anomalie est déjà résolue.', code: 'deja_resolue' });
  if (a.periode_verrouillee) return res.status(409).json(lockedMsg(a, 'résolue'));
  const motif = String((req.body && req.body.motif) || '').trim().slice(0, 500);
  if (!motif) return res.status(400).json({ error: 'Indiquez le motif de la résolution : il est inscrit au journal d’audit.', code: 'motif_requis' });
  db.prepare(`UPDATE anomalie SET statut='resolue', resolue_le=datetime('now'), motif_resolution=?, resolue_par=? WHERE id=? AND cabinet_id=?`).run(motif, req.user.id, a.id, req.cabinetId);
  audit(req.cabinetId, req.user.id, 'resolution_anomalie', 'anomalie', anoAuditCtx(req, a, { motif }), req.ip);
  res.json({ ok: true });
});

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
// Cellule CSV sûre : neutralise l'injection de formule (= + - @ tab CR) en
// préfixant par une apostrophe, et échappe délimiteur/guillemet/saut de ligne.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Erreurs Multer (taille dépassée, champ inattendu…) → 400 lisible, jamais 500 ni stack exposée.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    cleanupUploads(req);
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (maximum 25 Mo).'
      : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Trop de fichiers envoyés.'
      : 'Téléversement invalide.';
    return res.status(400).json({ error: msg });
  }
  next(err);
});

module.exports = router;
