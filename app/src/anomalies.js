'use strict';
/**
 * Anomalies — SOURCE UNIQUE des statuts et des compteurs (INC 2.1-A/C). Chaque écran passe par ici.
 *
 * Statuts :
 *  - « ouverte »    : anomalie active ;
 *  - « a_verifier » : « convention absente » dont le trimestre est COUVERT par une convention valide du fournisseur
 *                     (effet — sinon signature — ≤ fin du trimestre ; pas de fin ou fin ≥ début). Rapprochement
 *                     automatique : l'anomalie reste À TRAITER (comptée) tant qu'un utilisateur n'a pas validé la levée ;
 *  - « levee »      : levée VALIDÉE par un administrateur ou un comptable (justificatif présent) — hors compteurs ;
 *  - « resolue »    : marquée résolue manuellement (historique) — hors compteurs.
 * Lecture seule vis-à-vis du moteur : la règle LOT 4 (convention appliquée selon son statut) est inchangée.
 */
const { db } = require('./db');
const calc = require('./calc');

const LOCKED = new Set(['cloturee', 'declaree']);
const pad = n => String(n).padStart(2, '0');
function quarterBounds(annee, trimestre) {
  const start = `${annee}-${pad((trimestre - 1) * 3 + 1)}-01`;
  return { start, end: calc.iso(calc.getFinTrimestre(+annee, +trimestre)) };
}
const convStart = c => c.date_debut || c.date_signature || null;
/** La convention couvre-t-elle le trimestre ? (null = impossible à dire : convention non datée) */
function covers(c, annee, trimestre) {
  const s = convStart(c); if (!s) return null;
  const q = quarterBounds(annee, trimestre);
  return s <= q.end && (!c.date_fin || c.date_fin >= q.start);
}

function scopeWhere(scope) {
  const w = ['a.cabinet_id=?'], p = [scope.cabinetId];
  if (scope.entrepriseId) { w.push('a.entreprise_id=?'); p.push(scope.entrepriseId); }
  return { where: w.join(' AND '), params: p };
}

/** Anomalies d'un périmètre (cabinet, dossier éventuel), chacune avec son statut calculé et son contexte. */
function listAnomalies(scope) {
  const { where, params } = scopeWhere(scope);
  const rows = db.prepare(`SELECT a.*, e.raison_sociale ent, e.id ent_id, u.nom levee_validee_par_nom FROM anomalie a LEFT JOIN entreprise e ON e.id=a.entreprise_id LEFT JOIN utilisateur u ON u.id=a.levee_validee_par
    WHERE ${where} ORDER BY a.created_at DESC, a.rowid DESC`).all(...params);
  const convByFour = new Map();
  const convs = db.prepare(`SELECT * FROM convention WHERE cabinet_id=? AND statut='valide'${scope.entrepriseId ? ' AND entreprise_id=?' : ''}`)
    .all(...(scope.entrepriseId ? [scope.cabinetId, scope.entrepriseId] : [scope.cabinetId]));
  for (const c of convs) { const k = c.entreprise_id + '|' + c.fournisseur_id; if (!convByFour.has(k)) convByFour.set(k, []); convByFour.get(k).push(c); }
  const locked = new Set(db.prepare(`SELECT entreprise_id, annee, trimestre, statut FROM periode_declaration WHERE cabinet_id=?`).all(scope.cabinetId)
    .filter(p => LOCKED.has(p.statut)).map(p => `${p.entreprise_id}|${p.annee}|${p.trimestre}`));
  const convById = db.prepare('SELECT * FROM convention WHERE id=?');
  const facQ = db.prepare(`SELECT id, numero, date_facture, date_paiement, a_declarer, montant_amende, retard_jours FROM facture
    WHERE entreprise_id=? AND fournisseur_id=? AND numero=? ORDER BY (annee=? AND trimestre=?) DESC, rowid LIMIT 1`);
  return rows.map(a => {
    const out = { ...a, periode_verrouillee: a.annee != null && locked.has(`${a.entreprise_id}|${a.annee}|${a.trimestre}`) };
    if (a.type === 'convention_absente') {
      const m = String(a.details || '').match(/^Facture\s+([^\s:]+)/);
      const fac = m && m[1] !== '?' ? facQ.get(a.entreprise_id, a.entite_id, m[1], a.annee, a.trimestre) : null;
      out.facture = fac || null;
      const list = convByFour.get(a.entreprise_id + '|' + a.entite_id) || [];
      out.conventions_fournisseur = list.length;
      const cov = a.annee != null ? list.filter(c => covers(c, a.annee, a.trimestre)).sort((x, y) => (convStart(y) || '').localeCompare(convStart(x) || '')) : [];
      const conv = a.levee_convention_id ? (convById.get(a.levee_convention_id) || null) : (cov[0] || null);
      if (conv) out.convention = convSummary(conv, a, fac);
      out.situation = !list.length ? 'aucune'
        : (a.annee == null ? 'trimestre_inconnu' : (cov.length ? 'couverte' : (list.every(c => !convStart(c)) ? 'non_datee' : 'hors_periode')));
    }
    out.statut_calc = a.statut !== 'ouverte' ? 'resolue' : (a.levee_validee_le ? 'levee' : (out.situation === 'couverte' ? 'a_verifier' : 'ouverte'));
    return out;
  });
}
function convSummary(c, a, fac) {
  const q = a.annee != null ? quarterBounds(a.annee, a.trimestre) : null;
  const avert = [];
  if (q && c.created_at && c.created_at.slice(0, 10) > q.end) avert.push('Convention enregistrée après la fin du trimestre');
  if (fac && c.date_signature && fac.date_facture && c.date_signature > fac.date_facture) avert.push('Signée après la date de la facture');
  if (!c.fichier) avert.push('Justificatif manquant');
  return { id: c.id, delai: c.delai_convenu, date_signature: c.date_signature, date_debut: c.date_debut, date_fin: c.date_fin,
    enregistree_le: c.created_at, justificatif: !!c.fichier, avertissements: avert };
}

/** Compteurs — les SEULS utilisés par les écrans. « aTraiter » = ouvertes + à vérifier. */
function anomalyCounts(scope) {
  const n = { ouvertes: 0, aVerifier: 0, levees: 0, resolues: 0 };
  for (const a of listAnomalies(scope)) {
    if (a.statut_calc === 'ouverte') n.ouvertes++; else if (a.statut_calc === 'a_verifier') n.aVerifier++;
    else if (a.statut_calc === 'levee') n.levees++; else n.resolues++;
  }
  n.aTraiter = n.ouvertes + n.aVerifier;
  return n;
}

/** Fournisseurs « sans convention justificative » — définition UNIQUE (ANO-9) : délai de 120 j appliqué,
 *  aucune convention valide, au moins une facture à déclarer. */
function conventionsManquantes(scope) {
  return db.prepare(`SELECT fo.id, fo.raison_sociale four, fo.ice, fo.if_fiscal, e.id ent_id, e.raison_sociale ent,
      COUNT(f.id) nb, ROUND(SUM(f.ttc),2) ttc
    FROM fournisseur fo JOIN facture f ON f.fournisseur_id=fo.id AND f.a_declarer=1 JOIN entreprise e ON e.id=fo.entreprise_id
    WHERE fo.cabinet_id=?${scope.entrepriseId ? ' AND fo.entreprise_id=?' : ''} AND fo.delai_applicable>=120
      AND NOT EXISTS (SELECT 1 FROM convention c WHERE c.fournisseur_id=fo.id AND c.statut='valide')
    GROUP BY fo.id ORDER BY ttc DESC`).all(...(scope.entrepriseId ? [scope.cabinetId, scope.entrepriseId] : [scope.cabinetId]));
}

module.exports = { listAnomalies, anomalyCounts, conventionsManquantes, covers, quarterBounds, convStart, LOCKED };
