'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, tauxAt, audit } = require('./db');
const calc = require('./calc');
const periode = require('./periode');
const { importWorkbook } = require('./importer');
const reseau = require('./reseau');
const auth = require('./auth');
const visa = require('./visa');
const { rateLimit } = require('./security');
const { uid, normalizeIce, fmtMoney, slugify } = require('./util');

// Anti brute-force : max 10 tentatives de connexion / 15 min / IP.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,
  message: 'Trop de tentatives de connexion. Réessayez dans quelques minutes.' });

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
  const rows = db.prepare('SELECT * FROM facture WHERE entreprise_id=? AND annee=? AND trimestre=?')
    .all(entrepriseId, annee, trimestre);
  const upd = db.prepare(`UPDATE facture SET delai_applicable=?, delai_ecoule=?, date_limite=?,
    retard_jours=?, n_mois=?, a_declarer=?, taux_bam=?, taux_total=?, base_amende=?, montant_amende=?, couleur_risque=? WHERE id=?`);
  for (const f of rows) {
    const conv = db.prepare(`SELECT delai_convenu FROM convention WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide' ORDER BY created_at DESC LIMIT 1`).get(entrepriseId, f.fournisseur_id);
    const fRow = db.prepare('SELECT * FROM fournisseur WHERE id=?').get(f.fournisseur_id);
    // Délai AUTORISÉ résolu centralement (opérateur réseau 30 j → convention → standard 60 j), borné [1,120].
    const delai = reseau.resolveDelaiAutorise({ fournisseur: fRow, convention: conv }).delaiAutorise;
    const c = calc.computeFacture({ dateFacture: f.date_facture, datePaiement: f.date_paiement, ttc: f.ttc,
      delaiApplicable: delai, periode: { annee, trimestre }, tauxProvider: (y, m) => tauxAt(y, m, cabinetId) });
    upd.run(delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
      c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque, f.id);
  }
}

/* ============================================================ AUTH */
router.post('/auth/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
  const u = db.prepare('SELECT * FROM utilisateur WHERE email=? AND actif=1').get(String(email).toLowerCase().trim());
  // Comparaison systématique (hash factice si l'utilisateur n'existe pas) pour
  // ne pas révéler l'existence d'un compte par le temps de réponse.
  const ok = auth.verifyPassword(password, u ? u.password_hash : auth.DUMMY_HASH);
  if (!u || !ok)
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  const token = auth.signToken(u);
  auth.setAuthCookie(res, token);
  audit(u.cabinet_id, u.id, 'login', 'utilisateur', { email: u.email }, req.ip);
  res.json({ ok: true, user: publicUser(u) });
});
router.post('/auth/logout', (req, res) => { auth.clearAuthCookie(res); res.json({ ok: true }); });

router.get('/me', auth.requireAuth, (req, res) => {
  const cab = db.prepare('SELECT id, nom, slug, plan FROM cabinet WHERE id=?').get(req.cabinetId);
  res.json({ user: publicUser(req.user), cabinet: cab });
});
function publicUser(u) {
  return { id: u.id, nom: u.nom, email: u.email, role: u.role,
    initiales: u.initiales || (u.nom || 'U').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase(),
    titre: u.titre || 'Utilisateur' };
}

// tout ce qui suit exige l'authentification
router.use(auth.requireAuth);

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
  const convManquantes = db.prepare(`SELECT COUNT(*) n FROM fournisseur f
      WHERE f.cabinet_id=? AND EXISTS (SELECT 1 FROM facture x WHERE x.fournisseur_id=f.id AND x.a_declarer=1)
        AND NOT EXISTS (SELECT 1 FROM convention c WHERE c.fournisseur_id=f.id AND c.statut='valide')`).get(cid).n;

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
  const anomalies = db.prepare(`SELECT COUNT(*) n FROM anomalie WHERE cabinet_id=? AND statut='ouverte'`).get(cid).n;
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
      convValides, tauxConformite: tauxConf, dso: Math.round(paidAgg.dso), retardMoyen: Math.round(retMoy), anomalies,
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
  const rows = db.prepare(`SELECT e.*,
      (SELECT COUNT(*) FROM facture f WHERE f.entreprise_id=e.id AND f.a_declarer=1) retards,
      (SELECT COALESCE(SUM(f.montant_amende),0) FROM facture f WHERE f.entreprise_id=e.id AND f.a_declarer=1) amende
      FROM entreprise e WHERE e.cabinet_id=? ORDER BY e.raison_sociale`).all(req.cabinetId);
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
  if (!e) return res.status(404).json({ error: 'Client introuvable.' });
  e.assujettie = assujettie(e.ca_ht); e.regime = regimeOf(e.ca_ht, e.exercice_ref || 2026); e.type_visa = visaOf(e.ca_ht);
  res.json(e);
});
router.put('/clients/:id', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const p = latestPeriod(e.id);
  recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  const agg = db.prepare(`SELECT COUNT(*) nb, COALESCE(SUM(CASE WHEN a_declarer=1 THEN 1 ELSE 0 END),0) aDecl,
      COALESCE(SUM(CASE WHEN a_declarer=1 THEN ttc ELSE 0 END),0) ttcRetard,
      COALESCE(SUM(montant_amende),0) amende
      FROM facture WHERE entreprise_id=? AND annee=? AND trimestre=?`).get(e.id, p.annee, p.trimestre);
  const fournisseurs = db.prepare('SELECT COUNT(*) n FROM fournisseur WHERE entreprise_id=?').get(e.id).n;
  const conventions = db.prepare(`SELECT COUNT(*) n FROM convention WHERE entreprise_id=? AND statut='valide'`).get(e.id).n;
  const convManq = db.prepare(`SELECT COUNT(*) n FROM fournisseur f WHERE f.entreprise_id=? AND f.delai_applicable>=120
      AND NOT EXISTS (SELECT 1 FROM convention c WHERE c.fournisseur_id=f.id AND c.statut='valide')
      AND EXISTS (SELECT 1 FROM facture x WHERE x.fournisseur_id=f.id AND x.a_declarer=1)`).get(e.id).n;
  const periods = db.prepare(`SELECT DISTINCT annee, trimestre FROM facture WHERE entreprise_id=? AND annee IS NOT NULL ORDER BY annee DESC, trimestre DESC`).all(e.id);
  res.json({
    entreprise: { ...e, assujettie: assujettie(e.ca_ht), regime: regimeOf(e.ca_ht, e.exercice_ref || 2026), type_visa: visaOf(e.ca_ht) },
    periode: p, periods,
    kpis: { fournisseurs, conventions, convManq, factures: agg.nb, aDeclarer: agg.aDecl, ttcRetard: agg.ttcRetard, amende: agg.amende },
  });
});

router.get('/clients/:id/periods', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const info = buildPeriodsList(req.cabinetId, e.id);
  // `latest` conservé pour compat ; défaut = période de travail si elle contient des données, sinon la plus fournie.
  const hasWork = info.disponibles.some(d => d.annee === info.travail.annee && d.trimestre === info.travail.trimestre);
  const latest = hasWork ? info.travail : (info.plusFournie || latestPeriod(e.id));
  res.json({ periods: info.disponibles, latest, travail: info.travail, plusFournie: info.plusFournie, disponibles: info.disponibles });
});

// Détail + calendrier + statut d'une période précise (crée la ligne si absente).
router.get('/clients/:id/periods/:annee/:trimestre/summary', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
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
  const anomalies = db.prepare(`SELECT COUNT(*) n FROM anomalie WHERE entreprise_id=? AND annee=? AND trimestre=? AND statut='ouverte'`).get(e.id, p.annee, p.trimestre).n;
  res.json({
    periode: { annee: p.annee, trimestre: p.trimestre, ...info,
      statut: pr.statut, statutLabel: periode.STATUT_LABELS[pr.statut], verrouillee: periode.isLocked(pr.statut),
      date_cloture: pr.date_cloture, joursAvantEcheance: periode.joursAvantEcheance(p.annee, p.trimestre) },
    kpis: { documents: docs, lots, factures: agg.nb, aDeclarer: agg.aDecl, ttcRetard: agg.ttcRetard, amende: agg.amende, anomalies },
  });
});

// Clôture d'une période (réservé admin) → lecture seule.
router.post('/clients/:id/periods/:annee/:trimestre/close', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Seul un administrateur peut clôturer une période.' });
  const p = requirePeriod(req, res); if (!p) return;
  const pr = ensurePeriode(req.cabinetId, e.id, p.annee, p.trimestre);
  const statut = (req.body && req.body.statut === 'declaree') ? 'declaree' : 'cloturee';
  db.prepare(`UPDATE periode_declaration SET statut=?, date_cloture=datetime('now'), cloturee_par=?, updated_at=datetime('now') WHERE id=?`)
    .run(statut, req.user.id, pr.id);
  audit(req.cabinetId, req.user.id, 'cloture_periode', 'periode', { entreprise: e.id, annee: p.annee, trimestre: p.trimestre, statut }, req.ip);
  res.json({ ok: true, statut });
});

// Réouverture exceptionnelle (réservé admin, motif obligatoire) → audit.
router.post('/clients/:id/periods/:annee/:trimestre/reopen', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Seul un administrateur peut rouvrir une période.' });
  const motif = (req.body && req.body.motif || '').trim();
  if (!motif) return res.status(400).json({ error: 'Motif de réouverture obligatoire.' });
  const p = requirePeriod(req, res); if (!p) return;
  const pr = ensurePeriode(req.cabinetId, e.id, p.annee, p.trimestre);
  db.prepare(`UPDATE periode_declaration SET statut='rouverte', date_reouverture=datetime('now'), motif_reouverture=?, cloturee_par=?, updated_at=datetime('now') WHERE id=?`)
    .run(motif, req.user.id, pr.id);
  audit(req.cabinetId, req.user.id, 'reouverture_periode', 'periode', { entreprise: e.id, annee: p.annee, trimestre: p.trimestre, motif }, req.ip);
  res.json({ ok: true, statut: 'rouverte' });
});

router.get('/clients/:id/fournisseurs', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const rows = db.prepare(`SELECT f.*,
      (SELECT COUNT(*) FROM convention c WHERE c.fournisseur_id=f.id AND c.statut='valide') has_conv
      FROM fournisseur f WHERE f.entreprise_id=? ORDER BY f.raison_sociale`).all(e.id);
  res.json(rows);
});
router.post('/clients/:id/fournisseurs', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const rows = db.prepare(`SELECT c.*, f.raison_sociale four_nom, f.ice four_ice, f.if_fiscal four_if
      FROM convention c LEFT JOIN fournisseur f ON f.id=c.fournisseur_id
      WHERE c.entreprise_id=? ORDER BY c.created_at DESC`).all(e.id);
  res.json(rows.map(c => ({
    id: c.id, fournisseur: c.four_nom, four_ice: c.four_ice, four_if: c.four_if, fournisseur_id: c.fournisseur_id,
    objet: c.objet, delai: c.delai_convenu, date_debut: c.date_debut, date_fin: c.date_fin,
    statut: computeConvStatut(c), conforme: !!c.conforme, fichier: c.fichier ? c.id : null, fichier_nom: c.fichier_nom,
  })));
});
function computeConvStatut(c) {
  if (c.date_fin) {
    const fin = new Date(c.date_fin), today = new Date();
    if (fin < today) return 'Expirée';
    if ((fin - today) / 86400000 <= 30) return 'Bientôt expirée';
  }
  return 'Trouvée';
}
router.post('/clients/:id/conventions', upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) { cleanupUploads(req); return res.status(404).json({ error: 'Introuvable.' }); }
  const b = req.body || {};
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
                  VALUES (?,?,?,?,?,?,?)`).run(fournisseurId, req.cabinetId, e.id, b.fournisseur || null, iceN, b.four_if || null, Number(b.delai) || 120);
    }
  }
  const id = uid('conv');
  const delaiConv = calc.saneDelai(b.delai, 120);   // convention : défaut 120 j, plafond légal 120 j
  db.prepare(`INSERT INTO convention (id, cabinet_id, entreprise_id, fournisseur_id, objet, delai_convenu,
      date_signature, date_debut, date_fin, statut, conforme, fichier, fichier_nom)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.cabinetId, e.id, fournisseurId || null, b.objet || 'Délais de paiement', delaiConv,
      b.date_signature || null, b.date_debut || null, b.date_fin || null, 'valide',
      1, req.file ? req.file.filename : null, req.file ? req.file.originalname : null);
  if (fournisseurId) db.prepare('UPDATE fournisseur SET delai_applicable=? WHERE id=?').run(delaiConv, fournisseurId);
  const p = latestPeriod(e.id); recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  audit(req.cabinetId, req.user.id, 'create', 'convention', { id, entreprise: e.id }, req.ip);
  res.json({ ok: true, id });
});
router.get('/conventions/:id/file', (req, res) => {
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND cabinet_id=?').get(req.params.id, req.cabinetId);
  if (!c || !c.fichier) return res.status(404).send('Fichier introuvable');
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
function looksLikePdf(filePath, originalname) {
  if (path.extname(originalname || '').toLowerCase() !== '.pdf') return false;
  try { const fd = fs.openSync(filePath, 'r'); const b = Buffer.alloc(5); fs.readSync(fd, b, 0, 5, 0); fs.closeSync(fd); return b.toString('latin1') === '%PDF-'; }
  catch (_) { return false; }
}

// Import d'une LISTE de conventions (Excel) — crée les conventions SANS le PDF (document différé).
router.post('/clients/:id/conventions/import', heavyLimiter, upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) { cleanupUploads(req); return res.status(404).json({ error: 'Introuvable.' }); }
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
    // Recalcul de la période représentative (les nouveaux délais s'appliquent aux retards).
    const p = latestPeriod(e.id); recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
    audit(req.cabinetId, req.user.id, 'import_conventions', 'convention',
      { file: req.file.originalname, batch: r.batchId, created: r.conventionsCreated, conflicts: r.conflicts, rejected: r.rejected }, req.ip);
    res.json({ ok: true, ...r });
  } catch (err) { cleanupUploads(req); res.status(400).json({ error: err.message }); }
});

// Ajout (ou remplacement EXPLICITE) du PDF de convention. PDF uniquement, jamais d'écrasement silencieux.
router.post('/clients/:id/conventions/:convId/file', upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) { cleanupUploads(req); return res.status(404).json({ error: 'Introuvable.' }); }
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND entreprise_id=? AND cabinet_id=?').get(req.params.convId, e.id, req.cabinetId);
  if (!c) { cleanupUploads(req); return res.status(404).json({ error: 'Convention introuvable.' }); }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  if (!looksLikePdf(req.file.path, req.file.originalname)) { cleanupUploads(req); return res.status(400).json({ error: 'Le document doit être un fichier PDF.' }); }
  const replacing = !!c.fichier;
  const confirmReplace = req.query.replace === '1' || String((req.body || {}).replace) === '1';
  if (replacing && !confirmReplace) { cleanupUploads(req); return res.status(409).json({ error: 'Un document est déjà rattaché à cette convention. Confirmez le remplacement.', hasFile: true }); }
  // Nom de fichier généré côté serveur (anti path-traversal — aucune donnée du client dans le chemin).
  const stored = 'conv_' + uid('f').slice(-12) + '.pdf';
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const f = db.prepare('SELECT * FROM fournisseur WHERE id=? AND entreprise_id=?').get(req.params.fid, e.id);
  if (!f) return res.status(404).json({ error: 'Fournisseur introuvable.' });
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
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
// retard tombent dans Q → recalculées POUR Q. Additif : ne modifie pas les lignes stockées (CADOZAT intact).
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

router.get('/clients/:id/delais', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const rows = db.prepare(`SELECT f.*, fo.raison_sociale four_nom, fo.ice four_ice, fo.if_fiscal four_if,
      fo.operateur_reseau, fo.statut_classification, fo.hors_tableau_declaratif, fo.categorie_fournisseur, fo.delai_applicable fo_delai,
      (SELECT COUNT(*) FROM convention c WHERE c.fournisseur_id=f.fournisseur_id AND c.statut='valide') has_conv,
      (SELECT delai_convenu FROM convention c WHERE c.fournisseur_id=f.fournisseur_id AND c.statut='valide' ORDER BY created_at DESC LIMIT 1) conv_delai,
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
    const delaiApp = rd.delaiAutorise;
    const retard = arr.delaiConstate == null ? null : Math.max(0, arr.delaiConstate - delaiApp);
    return {
      id: f.id, numero: f.numero, four: f.four_nom, four_id: f.fournisseur_id, four_if: f.four_if, four_ice: f.four_ice, nature: f.designation,
      ttc: f.ttc, mht: f.mht, tva: f.tva, date_facture: f.date_facture, date_paiement: f.date_paiement,
      delai_ecoule: arr.delaiConstate, delai_applicable: delaiApp, date_limite: f.date_limite,
      arrete_au: arr.dateArreteIso, etat_paiement: arr.etat,
      operateur_reseau: rd.sourceRegle === 'operateur_reseau', categorie: f.categorie_fournisseur || 'standard', hors_tableau: rd.horsTableauDeclaratif, source_regle: rd.sourceRegle,
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
  const inc = incidenceFactures(req.cabinetId, e.id, p.annee, p.trimestre).map(({ f, c }) => ({
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
  const totals = {
    count: all.length, incidences: inc.length,
    ttc: round2(list.reduce((s, x) => s + (x.ttc || 0), 0)),
    aDeclarer: all.filter(x => x.a_declarer).length,
    ttcRetard: round2(all.filter(x => x.a_declarer).reduce((s, x) => s + (x.ttc || 0), 0)),
    amende: round2(all.reduce((s, x) => s + (x.amende || 0), 0)),
    amendeIncidence: round2(inc.reduce((s, x) => s + (x.amende || 0), 0)),
    retardMoyen: (() => { const r = all.filter(x => x.a_declarer); return r.length ? Math.round(r.reduce((s, x) => s + x.retard, 0) / r.length) : 0; })(),
    sansConvention: all.filter(x => !x.has_conv && x.delai_applicable >= 120).length,
  };
  res.json({ periode: p, rows: all, totals });
});
router.post('/clients/:id/recompute', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
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
  if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const statut = String((req.body && req.body.statut) || '').trim();
  if (!DOUBLON_STATUTS_REVUE.has(statut))
    return res.status(400).json({ error: 'Statut de revue invalide (attendu : confirme, faux_positif ou potentiel).' });
  const f = db.prepare('SELECT * FROM facture WHERE id=? AND entreprise_id=?').get(req.params.factureId, e.id);
  if (!f) return res.status(404).json({ error: 'Facture introuvable.' });
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
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
  const conv = db.prepare(`SELECT delai_convenu FROM convention WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide' LIMIT 1`).get(e.id, fId);
  const delai = conv ? conv.delai_convenu : 60;
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
  if (!e) { cleanupUploads(req); return res.status(404).json({ error: 'Introuvable.' }); }
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
function safeUploadPath(token) {
  const base = path.basename(String(token || ''));            // anti path-traversal
  if (!base || base.includes('/') || base.includes('\\')) return null;
  const p = path.join(UP_DIR, base);
  return fs.existsSync(p) ? p : null;
}
// Étape 2 — analyse du fichier (stocke un fichier temporaire, renvoie un token).
router.post('/clients/:id/import/analyze', upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {} return res.status(404).json({ error: 'Introuvable.' }); }
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  try {
    const buf = fs.readFileSync(req.file.path);
    const token = 'tmp_' + path.basename(req.file.path);
    fs.renameSync(req.file.path, path.join(UP_DIR, token));
    const analyse = importer.analyzeWorkbook(buf);
    audit(req.cabinetId, req.user.id, 'import_analyse', 'import', { file: req.file.originalname, entreprise: e.id }, req.ip);
    res.json({ ...analyse, token, sourceName: req.file.originalname, taille: req.file.size });
  } catch (err) { try { fs.unlinkSync(req.file.path); } catch (_) {} res.status(400).json({ error: err.message }); }
});
// Étape 4 — prévisualisation (aucune écriture).
router.post('/clients/:id/import/preview', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const b = req.body || {};
  const p = requirePeriod(req, res); if (!p) return;
  const tmp = safeUploadPath(b.token); if (!tmp) return res.status(400).json({ error: 'Fichier expiré ou introuvable — relancez l\'analyse.' });
  try {
    const out = importer.previewImport(fs.readFileSync(tmp), {
      sheetName: b.sheetName, headerRow: b.headerRow, mapping: b.mapping || {},
      cabinetId: req.cabinetId, entrepriseId: e.id, annee: p.annee, trimestre: p.trimestre, requireNumero: !!b.requireNumero,
    });
    res.json(out);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
// Étape 5 — confirmation (écrit en transaction).
router.post('/clients/:id/import/confirm', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const b = req.body || {};
  const p = requirePeriod(req, res); if (!p) return;
  if (!assertWritable(res, req.cabinetId, e.id, p.annee, p.trimestre)) return;
  const tmp = safeUploadPath(b.token); if (!tmp) return res.status(400).json({ error: 'Fichier expiré ou introuvable — relancez l\'analyse.' });
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
  if (!lot) return res.status(404).json({ error: 'Import introuvable.' });
  const rows = db.prepare(`SELECT numero_ligne, feuille, statut, motif, champ, donnees_brutes_json FROM import_ligne
    WHERE import_lot_id=? AND statut IN ('ignoree','rejetee','doublon') ORDER BY numero_ligne`).all(lot.id);
  res.json({ importId: lot.id, source: lot.source_nom, lignes: rows.map(r => ({ ...r, brut: JSON.parse(r.donnees_brutes_json || '[]') })) });
});
router.get('/imports/:importId/rejections.csv', (req, res) => {
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=?').get(req.params.importId, req.cabinetId);
  if (!lot) return res.status(404).send('Introuvable');
  const rows = db.prepare(`SELECT numero_ligne, feuille, statut, motif, champ, donnees_brutes_json FROM import_ligne
    WHERE import_lot_id=? AND statut IN ('ignoree','rejetee','doublon') ORDER BY numero_ligne`).all(lot.id);
  let csv = 'Ligne;Feuille;Statut;Motif;Champ;Donnees\n';
  for (const r of rows) csv += `${r.numero_ligne};${r.feuille || ''};${r.statut};${(r.motif || '').replace(/;/g, ',')};${r.champ || ''};${(r.donnees_brutes_json || '').replace(/[;\n]/g, ' ').slice(0, 300)}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rejets_${lot.id}.csv"`);
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
  if (!m) return res.status(404).json({ error: 'Introuvable.' });
  const b = req.body || {};
  db.prepare(`UPDATE modele_mapping SET nom=?, type_fichier=?, signature_colonnes=?, feuille=?, ligne_entete=?, mapping_json=?, transformations_json=?, updated_at=datetime('now'), derniere_utilisation=datetime('now') WHERE id=?`)
    .run(b.nom ?? m.nom, b.type_fichier ?? m.type_fichier, b.signature_colonnes ?? m.signature_colonnes, b.feuille ?? m.feuille,
      b.ligne_entete != null ? +b.ligne_entete : m.ligne_entete, JSON.stringify(b.mapping || JSON.parse(m.mapping_json || '{}')),
      JSON.stringify(b.transformations || JSON.parse(m.transformations_json || '{}')), m.id);
  res.json({ ok: true });
});
router.delete('/mapping-templates/:id', (req, res) => {
  const m = db.prepare('SELECT id FROM modele_mapping WHERE id=? AND cabinet_id=?').get(req.params.id, req.cabinetId);
  if (!m) return res.status(404).json({ error: 'Introuvable.' });
  db.prepare('DELETE FROM modele_mapping WHERE id=?').run(m.id);
  res.json({ ok: true });
});

router.get('/clients/:id/documents', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  // Isolation : si une période est fournie, ne renvoyer QUE ses fichiers.
  const p = readPeriodParams(req);
  const rows = p
    ? db.prepare(`SELECT id, type, nom, taille, mime, import_id, import_lot_id, nb_factures, annee, trimestre, created_at FROM document WHERE entreprise_id=? AND type='import' AND annee=? AND trimestre=? ORDER BY created_at DESC`).all(e.id, p.annee, p.trimestre)
    : db.prepare(`SELECT id, type, nom, taille, mime, import_id, import_lot_id, nb_factures, annee, trimestre, created_at FROM document WHERE entreprise_id=? AND type='import' ORDER BY created_at DESC`).all(e.id);
  res.json(rows);
});
router.get('/clients/:id/documents/:docId/download', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const doc = db.prepare('SELECT * FROM document WHERE id=? AND entreprise_id=?').get(req.params.docId, e.id);
  if (!doc || !doc.chemin) return res.status(404).send('Fichier introuvable');
  res.download(path.join(UP_DIR, doc.chemin), doc.nom || 'fichier');
});
router.delete('/clients/:id/documents/:docId', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const doc = db.prepare('SELECT * FROM document WHERE id=? AND entreprise_id=?').get(req.params.docId, e.id);
  if (!doc) return res.status(404).json({ error: 'Introuvable.' });
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
  if (!lot) return res.status(404).json({ error: 'Import introuvable.' });
  const nbFac = db.prepare('SELECT COUNT(*) n FROM facture WHERE import_id=?').get(lot.id).n;
  res.json({ ...lot, factures_actuelles: nbFac });
});
// Aperçu des conséquences d'une annulation (avant confirmation).
router.get('/clients/:id/import/:importId/impact', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=? AND entreprise_id=?').get(req.params.importId, req.cabinetId, e.id);
  if (!lot) return res.status(404).json({ error: 'Import introuvable.' });
  const agg = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(ttc),0) ttc FROM facture WHERE entreprise_id=? AND import_id=?').get(e.id, lot.id);
  const decl = db.prepare('SELECT COUNT(*) n FROM declaration WHERE entreprise_id=? AND annee=? AND trimestre=?').get(e.id, lot.annee, lot.trimestre).n;
  const pr = ensurePeriode(req.cabinetId, e.id, lot.annee, lot.trimestre);
  res.json({ importId: lot.id, annee: lot.annee, trimestre: lot.trimestre, factures: agg.n, total_ttc: round2(agg.ttc),
    declarations_affectees: decl, periode_statut: pr.statut, verrouillee: periode.isLocked(pr.statut) });
});
// Annulation atomique d'un import : retire UNIQUEMENT ses factures + anomalies. Réversibilité.
router.post('/clients/:id/import/:importId/cancel', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const lot = db.prepare('SELECT * FROM import_lot WHERE id=? AND cabinet_id=? AND entreprise_id=?').get(req.params.importId, req.cabinetId, e.id);
  if (!lot) return res.status(404).json({ error: 'Import introuvable.' });
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND entreprise_id=?').get(req.params.convId, e.id);
  if (!c) return res.status(404).json({ error: 'Introuvable.' });
  db.prepare('DELETE FROM convention WHERE id=?').run(c.id);
  if (c.fichier) try { fs.unlinkSync(path.join(UP_DIR, c.fichier)); } catch (_) {}
  if (c.fournisseur_id) {
    const rest = db.prepare(`SELECT COUNT(*) n FROM convention WHERE fournisseur_id=? AND statut='valide'`).get(c.fournisseur_id).n;
    if (!rest) db.prepare('UPDATE fournisseur SET delai_applicable=60 WHERE id=?').run(c.fournisseur_id);
  }
  const p = latestPeriod(e.id); recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  audit(req.cabinetId, req.user.id, 'delete', 'convention', { id: c.id }, req.ip);
  res.json({ ok: true });
});

/* ============================================================ DECLARATIONS */
function buildDeclaration(cabinetId, entreprise, annee, trimestre) {
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
  return { declaration: d, lignes, exclusions };
}
router.get('/clients/:id/declaration', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { declaration, lignes, exclusions } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  res.json({ entreprise: shapeEnt(e), declaration, lignes, exclusions });
});
function shapeEnt(e) { return { id: e.id, raison_sociale: e.raison_sociale, ice: e.ice, if_fiscal: e.if_fiscal, rc: e.rc, adresse: e.adresse, ville: e.ville, ca_ht: e.ca_ht, secteur: e.secteur, type_visa: visaOf(e.ca_ht) }; }

router.get('/clients/:id/declaration/export.csv', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { lignes } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  let csv = 'IF fournisseur;Raison sociale;Montant TTC;Non payees;Paye hors delai;Retard (j);Amende\n';
  for (const l of lignes) csv += `${csvCell(l.if)};${csvCell(l.nom)};${l.ttc};${l.non_paye};${l.hors_delai};${l.retard};${l.amende}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="declaration_${p.annee}_T${p.trimestre}.csv"`);
  res.send('﻿' + csv);
});
router.get('/clients/:id/declaration/export.xml', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { declaration, lignes } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<DeclarationDelaisPaiement annee="${p.annee}" periode="T${p.trimestre}">\n`;
  xml += `  <Declarant><RaisonSociale>${esc(e.raison_sociale)}</RaisonSociale><IF>${esc(e.if_fiscal)}</IF><ICE>${esc(e.ice)}</ICE><RC>${esc(e.rc)}</RC><CAHT>${e.ca_ht}</CAHT></Declarant>\n  <Factures>\n`;
  for (const l of lignes) xml += `    <Facture><IFFournisseur>${esc(l.if)}</IFFournisseur><RaisonSociale>${esc(l.nom)}</RaisonSociale><MontantTTC>${l.ttc}</MontantTTC><NonPaye>${l.non_paye}</NonPaye><PayeHorsDelai>${l.hors_delai}</PayeHorsDelai><Amende>${l.amende}</Amende></Facture>\n`;
  xml += `  </Factures>\n  <Recapitulatif><TotalTTC>${declaration.montant_total_ttc}</TotalTTC><TotalAmende>${declaration.montant_total_amende}</TotalAmende><MontantAVerser>${declaration.montant_a_verser}</MontantAVerser><TypeVisa>${declaration.type_visa}</TypeVisa></Recapitulatif>\n</DeclarationDelaisPaiement>\n`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="EDI_${p.annee}_T${p.trimestre}.xml"`);
  res.send(xml);
});

/* ============================================================ VISA */
function visaData(req, e) {
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { declaration } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  const conclusion = req.query.conclusion || 'Sans observation';
  const signataire = req.query.signataire || (db.prepare('SELECT nom FROM utilisateur WHERE id=?').get(req.user.id) || {}).nom || 'Le professionnel';
  const data = visa.buildData({ e, annee: p.annee, trimestre: p.trimestre, montant: declaration.montant_total_ttc, conclusion, signataire, type: visaOf(e.ca_ht) });
  return { p, declaration, data };
}
router.get('/clients/:id/visa', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const { p, declaration, data } = visaData(req, e);
  res.json({
    type: data.type, typeLabel: data.typeLabel, periode: p,
    montant_vise: declaration.montant_total_ttc, montant_amende: declaration.montant_total_amende,
    conclusion: data.conclusion, signataire: data.signataire, reference: 'Article 2.78 · Directive OEC du 06/10/2024',
    lieu: data.lieu, date: data.date, debut: data.debut, fin: data.fin, blocks: data.blocks,
  });
});
router.get('/clients/:id/visa/export.docx', asyncHandler(async (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const { p, data } = visaData(req, e);
  const buf = await visa.toDocx(data.blocks);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="Visa_${slugify(e.raison_sociale)}_T${p.trimestre}_${p.annee}.docx"`);
  audit(req.cabinetId, req.user.id, 'export', 'visa', { format: 'docx', entreprise: e.id }, req.ip);
  res.send(buf);
}));
router.get('/clients/:id/visa/export.pdf', (req, res, next) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const { p, data } = visaData(req, e);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Visa_${slugify(e.raison_sociale)}_T${p.trimestre}_${p.annee}.pdf"`);
  audit(req.cabinetId, req.user.id, 'export', 'visa', { format: 'pdf', entreprise: e.id }, req.ip);
  try {
    const doc = visa.toPdf(data.blocks, res);
    if (doc && doc.on) doc.on('error', next);
  } catch (err) { next(err); }
});

/* ============================================================ ALERTES / ANOMALIES */
router.get('/alerts', (req, res) => {
  const cid = req.cabinetId; const out = [];
  // conventions manquantes (fournisseurs 120 sans convention avec factures en retard)
  const cm = db.prepare(`SELECT e.raison_sociale ent, fo.raison_sociale four, COUNT(f.id) n
     FROM facture f JOIN fournisseur fo ON fo.id=f.fournisseur_id JOIN entreprise e ON e.id=f.entreprise_id
     WHERE f.cabinet_id=? AND f.a_declarer=1 AND fo.delai_applicable>=120
       AND NOT EXISTS (SELECT 1 FROM convention c WHERE c.fournisseur_id=fo.id AND c.statut='valide')
     GROUP BY fo.id LIMIT 20`).all(cid);
  for (const r of cm) out.push({ type: 'convention', severite: 'm', icon: 'orange', titre: 'Convention manquante', message: `${r.four} — délai 120 j appliqué sans convention en GED (${r.ent}).`, date: 'Détecté à l\'import' });
  // anomalies de données
  const anos = db.prepare(`SELECT a.*, e.raison_sociale ent FROM anomalie a LEFT JOIN entreprise e ON e.id=a.entreprise_id
     WHERE a.cabinet_id=? AND a.statut='ouverte' ORDER BY a.created_at DESC LIMIT 30`).all(cid);
  for (const a of anos) out.push({ type: a.type, severite: a.gravite === 'haute' ? 'h' : (a.gravite === 'moyenne' ? 'm' : 'l'),
    icon: a.gravite === 'haute' ? 'red' : 'yellow', titre: anomalieLabel(a.type), message: a.details, date: a.created_at });
  // échéances
  for (const d of nextDeadlines().slice(0, 2)) out.push({ type: 'echeance', severite: d.days <= 15 ? 'h' : 'm', icon: d.days <= 15 ? 'dred' : 'orange', titre: 'Échéance de déclaration', message: `${d.label} — dépôt SIMPL le ${d.day}/${monNum(d.mon)}.`, date: d.cd });
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
  const rows = db.prepare(`SELECT fo.id four_id, fo.raison_sociale four, fo.ice, fo.if_fiscal, fo.delai_applicable,
     e.id ent_id, e.raison_sociale ent,
     (SELECT COUNT(*) FROM facture x WHERE x.fournisseur_id=fo.id AND x.a_declarer=1) nb,
     (SELECT COALESCE(SUM(x.ttc),0) FROM facture x WHERE x.fournisseur_id=fo.id AND x.a_declarer=1) ttc
     FROM fournisseur fo JOIN entreprise e ON e.id=fo.entreprise_id
     WHERE fo.cabinet_id=? AND fo.delai_applicable>=120
       AND NOT EXISTS (SELECT 1 FROM convention c WHERE c.fournisseur_id=fo.id AND c.statut='valide')
       AND EXISTS (SELECT 1 FROM facture x WHERE x.fournisseur_id=fo.id AND x.a_declarer=1)
     ORDER BY nb DESC`).all(req.cabinetId);
  res.json(rows);
});
router.get('/portfolio/conventions', (req, res) => {
  const rows = db.prepare(`SELECT c.*, e.raison_sociale ent, e.id ent_id, fo.raison_sociale four, fo.ice four_ice
     FROM convention c JOIN entreprise e ON e.id=c.entreprise_id LEFT JOIN fournisseur fo ON fo.id=c.fournisseur_id
     WHERE c.cabinet_id=? AND c.statut='valide' ORDER BY e.raison_sociale, fo.raison_sociale`).all(req.cabinetId);
  res.json(rows.map(c => ({ id: c.id, ent: c.ent, ent_id: c.ent_id, four: c.four, four_ice: c.four_ice, delai: c.delai_convenu, date_fin: c.date_fin, statut: computeConvStatut(c), fichier: c.fichier ? c.id : null })));
});
router.get('/anomalies', (req, res) => {
  const rows = db.prepare(`SELECT a.*, e.raison_sociale ent, e.id ent_id FROM anomalie a LEFT JOIN entreprise e ON e.id=a.entreprise_id
     WHERE a.cabinet_id=? ORDER BY (a.statut='ouverte') DESC, a.created_at DESC LIMIT 300`).all(req.cabinetId);
  res.json(rows);
});
router.post('/anomalies/:id/resolve', (req, res) => {
  db.prepare(`UPDATE anomalie SET statut='resolue', resolue_le=datetime('now') WHERE id=? AND cabinet_id=?`).run(req.params.id, req.cabinetId);
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
