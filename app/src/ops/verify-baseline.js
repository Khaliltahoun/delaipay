'use strict';
/**
 * Contrôle de non-régression sur une base (restaurée, migrée ou staging) : déclaration d'un dossier et empreinte du CSV DGI,
 * calculés par l'APPLICATION elle-même (mêmes routes que l'interface), sans rien modifier.
 *
 *   DB_PATH=… node src/ops/verify-baseline.js --slug hlz-demo --annee 2026 --trimestre 1 [--client "STE ORYX AUTO SARL"]
 *        [--expect "36,16,350964.42,7025.33,a7d1acaac0688170ef95fce6b7bb2082"]
 * Code de sortie 0 si conforme à --expect (ou sans --expect), 1 sinon.
 */
process.env.DELAIPAY_AUTO_SEED = '0';
const crypto = require('crypto');
const http = require('http');

function args() { const a = {}; const v = process.argv.slice(2); for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true; return a; }
async function verify({ slug, annee = 2026, trimestre = 1, client = null }) {
  const { db } = require('../db');
  const tenant = require('../tenant');
  const auth = require('../auth');
  const cab = db.prepare('SELECT * FROM cabinet WHERE lower(slug)=?').get(String(slug).toLowerCase());
  if (!cab) throw new Error(`Espace « ${slug} » introuvable.`);
  const ent = client ? db.prepare('SELECT * FROM entreprise WHERE cabinet_id=? AND raison_sociale=?').get(cab.id, client)
    : db.prepare('SELECT * FROM entreprise WHERE cabinet_id=? ORDER BY created_at LIMIT 1').get(cab.id);
  if (!ent) throw new Error('Aucun dossier client dans cet espace.');
  const admin = db.prepare(`SELECT * FROM utilisateur WHERE cabinet_id=? AND actif=1 ORDER BY role='admin' DESC, created_at LIMIT 1`).get(cab.id);
  // Session technique ÉPHÉMÈRE (lecture seule du résultat), fermée à la fin : aucune donnée métier modifiée.
  const sid = require('../sessions').open({ cabinetId: cab.id, userId: admin.id });
  const cookie = `${auth.COOKIE}=${auth.signToken(admin, { sid })}`;
  const srv = require('../app').createApp().listen(0);
  const host = `${cab.slug}.${tenant.baseDomains()[0] || 'localhost'}`;
  const get = p => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers: { Host: host, Cookie: cookie } }, r => {
    const b = []; r.on('data', c => b.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(b) }));
  }).on('error', rej));
  try {
    const q = `?annee=${annee}&trimestre=${trimestre}`;
    const decl = await get(`/api/clients/${ent.id}/declaration${q}`);
    const delais = await get(`/api/clients/${ent.id}/delais${q}`);
    const csv = await get(`/api/clients/${ent.id}/declaration/export.csv${q}`);
    if (decl.status !== 200 || csv.status !== 200) throw new Error(`Réponses inattendues : déclaration ${decl.status}, CSV ${csv.status}`);
    const d = JSON.parse(decl.body.toString()).declaration;
    const dl = JSON.parse(delais.body.toString()); const rows = Array.isArray(dl) ? dl : (dl.rows || []);
    return { espace: cab.slug, client: ent.raison_sociale, periode: `T${trimestre} ${annee}`, factures: rows.length, lignes: d.nb_lignes,
      ttc: d.montant_total_ttc, amende: d.montant_total_amende, csv_md5: crypto.createHash('md5').update(csv.body).digest('hex') };
  } finally { srv.close(); require('../sessions').end(sid, 'verification'); }
}
module.exports = { verify };
if (require.main === module) {
  const a = args();
  verify({ slug: a.slug, annee: +(a.annee || 2026), trimestre: +(a.trimestre || 1), client: a.client || null }).then(r => {
    console.log(JSON.stringify(r, null, 2));
    if (a.expect) {
      const [f, l, t, am, md5] = String(a.expect).split(',');
      const ok = r.factures === +f && r.lignes === +l && Math.abs(r.ttc - +t) < 0.005 && Math.abs(r.amende - +am) < 0.005 && r.csv_md5 === md5;
      console.log(ok ? 'CONFORME à la référence.' : 'NON CONFORME à la référence.');
      process.exit(ok ? 0 : 1);
    }
  }).catch(e => { console.error('ÉCHEC : ' + e.message); process.exit(1); });
}
