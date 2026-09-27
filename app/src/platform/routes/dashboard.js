'use strict';
/** Console — tableau de bord : indicateurs de la plateforme et état du système (aucune donnée métier). */
const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('../../db');
const views = require('../workspaces');
const lifecycle = require('../../lifecycle');
const loginActivity = require('../../login-activity');
const support = require('../../support-access');
const runtime = require('../../runtime');

function dbSize() {
  let n = 0; for (const s of ['', '-wal', '-shm']) { try { n += fs.statSync(DB_PATH + s).size; } catch (_) {} }
  return n;
}
/** Dernière sauvegarde : fichier le plus récent de BACKUP_DIR (aucune sauvegarde automatique n'est configurée par défaut). */
function lastBackup() {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return { configure: false, message: 'Aucune sauvegarde configurée' };
  try {
    const files = fs.readdirSync(dir).map(f => { const st = fs.statSync(path.join(dir, f)); return st.isFile() ? { f, t: st.mtimeMs, size: st.size } : null; }).filter(Boolean).sort((a, b) => b.t - a.t);
    if (!files.length) return { configure: true, message: 'Aucune sauvegarde trouvée dans BACKUP_DIR' };
    return { configure: true, fichier: files[0].f, le: new Date(files[0].t).toISOString(), taille: files[0].size };
  } catch (_) { return { configure: true, message: 'BACKUP_DIR illisible' }; }
}

module.exports = function (api, { version } = {}) {
  api.get('/dashboard', (req, res) => {
    const ws = views.list();
    const byStatus = { actif: 0, suspendu: 0, expire: 0, supprime: 0 };
    for (const w of ws) byStatus[w.statut] = (byStatus[w.statut] || 0) + 1;
    const today = lifecycle.today(), in30 = lifecycle.addDays(today, 30), month = today.slice(0, 7);
    const subs = db.prepare(`SELECT a.*, c.slug, c.nom, c.nom_affiche FROM abonnement a JOIN cabinet c ON c.id=a.cabinet_id WHERE c.supprime_le IS NULL`).all();
    const renouvellements = subs.filter(a => a.date_fin && a.date_fin >= today && a.date_fin <= in30).sort((a, b) => a.date_fin.localeCompare(b.date_fin))
      .map(a => ({ id: a.cabinet_id, slug: a.slug, nom: a.nom_affiche || a.nom, date_fin: a.date_fin, montant: a.montant, statut_paiement: a.statut_paiement }));
    const echus = subs.filter(a => a.date_fin && a.date_fin < today).map(a => ({ id: a.cabinet_id, slug: a.slug, date_fin: a.date_fin, etat: lifecycle.subscriptionState(a.cabinet_id).etat }));
    const duMois = subs.filter(a => a.date_debut && a.date_debut.slice(0, 7) === month);
    const sum = arr => Math.round(arr.reduce((s, a) => s + (a.montant || 0), 0) * 100) / 100;
    const k24 = loginActivity.counts24h();
    res.json({
      espaces: { total: ws.length, ...byStatus },
      abonnements: { expirent30j: renouvellements.length, renouvellements, echus,
        revenuMois: { facture: sum(duMois), encaisse: sum(duMois.filter(a => a.statut_paiement === 'paye')), nb: duMois.length, mois: month },
        prochainsRenouvellements: sum(renouvellements), enRetard: subs.filter(a => a.statut_paiement === 'en_retard').length },
      utilisateurs: db.prepare(`SELECT COUNT(*) n FROM utilisateur u JOIN cabinet c ON c.id=u.cabinet_id WHERE u.actif=1 AND c.supprime_le IS NULL`).get().n,
      connexions24h: k24.succes, echecs24h: k24.echec + k24.verrouillage, bloquees24h: k24.bloque_politique, attente24h: k24.appareil_en_attente,
      appareilsEnAttente: db.prepare(`SELECT COUNT(*) n FROM device WHERE statut='en_attente'`).get().n,
      accesSupportActifs: support.activeCount(),
      signaux: loginActivity.signals().length,
      systeme: { version, ...runtime.snapshot(), node: process.version, base: { taille: dbSize(), fichier: path.basename(DB_PATH) }, sauvegarde: lastBackup(),
        geoip: require('../../geoip').configured(), proxyDeConfiance: process.env.TRUST_PROXY || null },
    });
  });
};

// Rétention des données de connexion (réglage ; la purge reste une commande serveur).
module.exports.retention = function (api) {
  const retention = require('../../retention');
  const store = require('../store');
  api.get('/retention', (req, res) => res.json({ mois: retention.months(), defaut: retention.DEFAULT_MONTHS, apercu: retention.plan(), tables: retention.TABLES }));
  api.put('/retention', (req, res) => {
    try {
      const avant = retention.months();
      const mois = retention.setMonths((req.body || {}).mois, req.padmin.email);
      store.paudit(req.padmin, 'retention_modifiee', { type: 'plateforme', libelle: 'données de connexion', avant: { mois: avant }, apres: { mois } }, req);
      res.json({ ok: true, mois, apercu: retention.plan() });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
};
