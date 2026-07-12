'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, tauxAt, audit } = require('./db');
const calc = require('./calc');
const { importWorkbook } = require('./importer');
const auth = require('./auth');
const visa = require('./visa');
const { uid, normalizeIce, fmtMoney, slugify } = require('./util');

const UP_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UP_DIR, { recursive: true });
const upload = multer({ dest: UP_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

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
function latestPeriod(entrepriseId) {
  const r = db.prepare(`SELECT annee, trimestre FROM facture WHERE entreprise_id=? AND annee IS NOT NULL
                        ORDER BY annee DESC, trimestre DESC LIMIT 1`).get(entrepriseId);
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
    const fRow = db.prepare('SELECT delai_applicable FROM fournisseur WHERE id=?').get(f.fournisseur_id);
    const delai = conv ? conv.delai_convenu : (fRow && fRow.delai_applicable ? fRow.delai_applicable : (f.delai_applicable || 60));
    const c = calc.computeFacture({ dateFacture: f.date_facture, datePaiement: f.date_paiement, ttc: f.ttc,
      delaiApplicable: delai, periode: { annee, trimestre }, tauxProvider: (y, m) => tauxAt(y, m, cabinetId) });
    upd.run(delai, c.delaiEcoule, c.dateLimite, c.retardJours, c.nMois, c.aDeclarer ? 1 : 0,
      c.tauxBam, c.tauxTotal, c.baseAmende, c.montantAmende, c.couleurRisque, f.id);
  }
}

/* ============================================================ AUTH */
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });
  const u = db.prepare('SELECT * FROM utilisateur WHERE email=? AND actif=1').get(String(email).toLowerCase().trim());
  if (!u || !auth.verifyPassword(password, u.password_hash))
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
  const per = db.prepare(`SELECT annee, trimestre FROM facture WHERE cabinet_id=? AND annee IS NOT NULL
                          ORDER BY annee DESC, trimestre DESC LIMIT 1`).get(cid)
             || { annee: new Date().getFullYear(), trimestre: Math.floor(new Date().getMonth() / 3) + 1 };
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

  res.json({
    periode: per,
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
  const rows = db.prepare(`SELECT DISTINCT annee, trimestre FROM facture WHERE entreprise_id=? AND annee IS NOT NULL
                           ORDER BY annee DESC, trimestre DESC`).all(e.id);
  res.json({ periods: rows, latest: latestPeriod(e.id) });
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
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const b = req.body || {};
  let fournisseurId = b.fournisseur_id;
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
  db.prepare(`INSERT INTO convention (id, cabinet_id, entreprise_id, fournisseur_id, objet, delai_convenu,
      date_signature, date_debut, date_fin, statut, conforme, fichier, fichier_nom)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.cabinetId, e.id, fournisseurId || null, b.objet || 'Délais de paiement', Number(b.delai) || 120,
      b.date_signature || null, b.date_debut || null, b.date_fin || null, 'valide',
      (Number(b.delai) || 120) <= 120 ? 1 : 0, req.file ? req.file.filename : null, req.file ? req.file.originalname : null);
  if (fournisseurId) db.prepare('UPDATE fournisseur SET delai_applicable=? WHERE id=?').run(Number(b.delai) || 120, fournisseurId);
  const p = latestPeriod(e.id); recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  audit(req.cabinetId, req.user.id, 'create', 'convention', { id, entreprise: e.id }, req.ip);
  res.json({ ok: true, id });
});
router.get('/conventions/:id/file', (req, res) => {
  const c = db.prepare('SELECT * FROM convention WHERE id=? AND cabinet_id=?').get(req.params.id, req.cabinetId);
  if (!c || !c.fichier) return res.status(404).send('Fichier introuvable');
  res.download(path.join(UP_DIR, c.fichier), c.fichier_nom || 'convention');
});

/* ============================================================ DELAIS (calc table) */
router.get('/clients/:id/delais', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const rows = db.prepare(`SELECT f.*, fo.raison_sociale four_nom, fo.ice four_ice, fo.if_fiscal four_if,
      (SELECT COUNT(*) FROM convention c WHERE c.fournisseur_id=f.fournisseur_id AND c.statut='valide') has_conv
      FROM facture f LEFT JOIN fournisseur fo ON fo.id=f.fournisseur_id
      WHERE f.entreprise_id=? AND f.annee=? AND f.trimestre=? ORDER BY f.montant_amende DESC, f.retard_jours DESC`)
    .all(e.id, p.annee, p.trimestre);
  const list = rows.map(f => ({
    id: f.id, numero: f.numero, four: f.four_nom, four_if: f.four_if, four_ice: f.four_ice, nature: f.designation,
    ttc: f.ttc, mht: f.mht, tva: f.tva, date_facture: f.date_facture, date_paiement: f.date_paiement,
    delai_ecoule: f.delai_ecoule, delai_applicable: f.delai_applicable, date_limite: f.date_limite,
    retard: f.retard_jours, n_mois: f.n_mois, a_declarer: !!f.a_declarer, has_conv: !!f.has_conv,
    taux_bam: f.taux_bam, taux_total: f.taux_total, amende: f.montant_amende, risk: f.couleur_risque,
  }));
  const totals = {
    count: list.length,
    ttc: round2(list.reduce((s, x) => s + (x.ttc || 0), 0)),
    aDeclarer: list.filter(x => x.a_declarer).length,
    ttcRetard: round2(list.filter(x => x.a_declarer).reduce((s, x) => s + (x.ttc || 0), 0)),
    amende: round2(list.reduce((s, x) => s + (x.amende || 0), 0)),
    retardMoyen: (() => { const r = list.filter(x => x.a_declarer); return r.length ? Math.round(r.reduce((s, x) => s + x.retard, 0) / r.length) : 0; })(),
    sansConvention: list.filter(x => !x.has_conv && x.delai_applicable >= 120).length,
  };
  res.json({ periode: p, rows: list, totals });
});
router.post('/clients/:id/recompute', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  recomputePeriod(req.cabinetId, e.id, p.annee, p.trimestre);
  res.json({ ok: true });
});

/* ============================================================ FACTURE manuelle */
router.post('/clients/:id/factures', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const b = req.body || {};
  const iceN = normalizeIce(b.four_ice);
  let fId = b.fournisseur_id;
  if (!fId) {
    let f = iceN ? db.prepare('SELECT id FROM fournisseur WHERE entreprise_id=? AND ice=?').get(e.id, iceN) : null;
    if (f) fId = f.id;
    else { fId = uid('four'); db.prepare('INSERT INTO fournisseur (id,cabinet_id,entreprise_id,raison_sociale,ice,if_fiscal,delai_applicable) VALUES (?,?,?,?,?,?,60)').run(fId, req.cabinetId, e.id, b.fournisseur || null, iceN, b.four_if || null); }
  }
  const mht = Number(b.mht) || 0, tva = Number(b.tva) || 0; let ttc = Number(b.ttc) || round2(mht + tva);
  const conv = db.prepare(`SELECT delai_convenu FROM convention WHERE entreprise_id=? AND fournisseur_id=? AND statut='valide' LIMIT 1`).get(e.id, fId);
  const delai = conv ? conv.delai_convenu : 60;
  const dpai = b.date_paiement ? calc.parseDate(b.date_paiement) : null;
  const per = dpai ? { annee: dpai.getFullYear(), trimestre: calc.trimestreOf(dpai) } : latestPeriod(e.id);
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
router.post('/clients/:id/import', upload.single('file'), (req, res) => {
  const e = ownedEntreprise(req, req.params.id);
  if (!e) return res.status(404).json({ error: 'Introuvable.' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
  try {
    const buf = fs.readFileSync(req.file.path);
    const periode = req.body.annee ? { annee: +req.body.annee, trimestre: +req.body.trimestre } : null;
    const result = importWorkbook(buf, { cabinetId: req.cabinetId, entrepriseId: e.id, sourceName: req.file.originalname, periode });
    db.prepare(`INSERT INTO document (id,cabinet_id,entreprise_id,type,nom,chemin,taille,mime) VALUES (?,?,?,?,?,?,?,?)`)
      .run(uid('doc'), req.cabinetId, e.id, 'import', req.file.originalname, req.file.filename, req.file.size, req.file.mimetype);
    audit(req.cabinetId, req.user.id, 'import', 'facture', { file: req.file.originalname, ...result.totals }, req.ip);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: 'Import impossible : ' + err.message });
  } finally { fs.unlink(req.file.path, () => {}); }
});

/* ============================================================ DECLARATIONS */
function buildDeclaration(cabinetId, entreprise, annee, trimestre) {
  recomputePeriod(cabinetId, entreprise.id, annee, trimestre);
  const facs = db.prepare(`SELECT f.*, fo.raison_sociale four_nom, fo.if_fiscal four_if
     FROM facture f LEFT JOIN fournisseur fo ON fo.id=f.fournisseur_id
     WHERE f.entreprise_id=? AND f.annee=? AND f.trimestre=? AND f.a_declarer=1
     ORDER BY f.montant_amende DESC`).all(entreprise.id, annee, trimestre);
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
  return { declaration: d, lignes };
}
router.get('/clients/:id/declaration', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { declaration, lignes } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  res.json({ entreprise: shapeEnt(e), declaration, lignes });
});
function shapeEnt(e) { return { id: e.id, raison_sociale: e.raison_sociale, ice: e.ice, if_fiscal: e.if_fiscal, rc: e.rc, adresse: e.adresse, ville: e.ville, ca_ht: e.ca_ht, secteur: e.secteur, type_visa: visaOf(e.ca_ht) }; }

router.get('/clients/:id/declaration/export.csv', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const p = req.query.annee ? { annee: +req.query.annee, trimestre: +req.query.trimestre } : latestPeriod(e.id);
  const { lignes } = buildDeclaration(req.cabinetId, e, p.annee, p.trimestre);
  let csv = 'IF fournisseur;Raison sociale;Montant TTC;Non payees;Paye hors delai;Retard (j);Amende\n';
  for (const l of lignes) csv += `${l.if || ''};${(l.nom || '').replace(/;/g, ',')};${l.ttc};${l.non_paye};${l.hors_delai};${l.retard};${l.amende}\n`;
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
router.get('/clients/:id/visa/export.docx', async (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const { p, data } = visaData(req, e);
  const buf = await visa.toDocx(data.blocks);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="Visa_${slugify(e.raison_sociale)}_T${p.trimestre}_${p.annee}.docx"`);
  audit(req.cabinetId, req.user.id, 'export', 'visa', { format: 'docx', entreprise: e.id }, req.ip);
  res.send(buf);
});
router.get('/clients/:id/visa/export.pdf', (req, res) => {
  const e = ownedEntreprise(req, req.params.id); if (!e) return res.status(404).send('Introuvable');
  const { p, data } = visaData(req, e);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Visa_${slugify(e.raison_sociale)}_T${p.trimestre}_${p.annee}.pdf"`);
  audit(req.cabinetId, req.user.id, 'export', 'visa', { format: 'pdf', entreprise: e.id }, req.ip);
  visa.toPdf(data.blocks, res);
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
function anomalieLabel(t) { return ({ date_incoherente: 'Date incohérente', date_future: 'Date dans le futur', date_manquante: 'Date manquante', montant_incoherent: 'Montant incohérent', doublon: 'Doublon détecté' })[t] || 'Anomalie'; }
function monNum(m) { return ({ Avr: '04', Jul: '07', Oct: '10', Jan: '01' })[m] || m; }

/* ============================================================ TAUX BAM */
router.get('/taux', (req, res) => {
  const rows = db.prepare(`SELECT * FROM taux_bam WHERE cabinet_id IS NULL OR cabinet_id=? ORDER BY date_debut DESC`).all(req.cabinetId);
  res.json(rows);
});
router.post('/taux', (req, res) => {
  const b = req.body || {};
  if (!b.taux || !b.date_debut) return res.status(400).json({ error: 'Taux et date de début requis.' });
  const id = uid('tx');
  db.prepare(`INSERT INTO taux_bam (id, cabinet_id, taux, date_debut, date_fin, reference) VALUES (?,?,?,?,?,?)`)
    .run(id, req.cabinetId, Number(b.taux), b.date_debut, b.date_fin || null, b.reference || null);
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
module.exports = router;
