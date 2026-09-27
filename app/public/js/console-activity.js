'use strict';
/* Console — activité de connexion des espaces et signaux (informatifs, aucun blocage automatique). */
(window.DPC_EXT = window.DPC_EXT || []).push(function (C) {
const { $, esc, IC } = C;
const RES = { succes: ['Réussie', 'pill-ok'], echec: ['Échec', 'pill-late'], verrouillage: ['Verrouillage', 'pill-severe'], bloque_politique: ['Bloquée (politique)', 'pill-warn'], appareil_en_attente: ['Appareil en attente', 'pill-app'] };
const MOTIF = { ip_non_autorisee: 'IP non autorisée', ip_bloquee: 'IP bloquée', appareil_en_attente: 'appareil à approuver', appareil_refuse: 'appareil refusé', appareil_expire: 'approbation expirée' };
const SIG = { echecs_repetes: 'Échecs répétés', nouveau_pays: 'Nouveau pays', nouvel_appareil_admin: 'Nouvel appareil (administrateur)' };
let f = { cabinet: '', resultat: '', heures: '168' };
C.signalsHtml = (sig) => sig.length
  ? `<div style="display:grid;gap:8px">${sig.map(s => `<div class="note ${s.gravite === 'eleve' ? 'note-danger' : 'note-warn'}">${IC.warn}<div><div class="note-t">${esc(SIG[s.type] || s.type)} · <a href="#/workspace/${esc(s.espace.id)}/securite">${esc(s.espace.slug || '—')}</a> · <span class="muted t-xs">${C.fdt(s.date)}</span></div>${esc(s.message)}</div></div>`).join('')}</div>`
  : `<p class="t-sm muted m-0">Aucun signal sur les 7 derniers jours.</p>`;
C.views.activity = async (el) => {
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const [d, ws] = await Promise.all([C.api('GET', '/login-activity?limit=500&' + qs), C.api('GET', '/workspaces')]);
  const k = d.compteurs24h;
  const badge = $('#sigBadge'); badge.textContent = d.signaux.length; badge.classList.toggle('hidden', !d.signaux.length);
  el.innerHTML = C.pageHead('Activité de connexion', `Connexions aux espaces : succès, échecs, verrouillages, refus par la politique d’accès, appareils en attente. Les signaux sont <b>informatifs</b> : aucun blocage automatique au-delà des verrouillages existants.${d.geoip ? '' : ' Signal « nouveau pays » inactif : aucune base GeoIP locale configurée (GEOIP_DB).'}`)
    + `<div class="kpi-grid">
      <div class="kpi"><div class="lbl">Connexions réussies · 24 h</div><div class="val">${C.int(k.succes)}</div></div>
      <div class="kpi ${k.echec ? 'late' : ''}"><div class="lbl">Échecs · 24 h</div><div class="val">${C.int(k.echec)}</div></div>
      <div class="kpi ${k.verrouillage ? 'late' : ''}"><div class="lbl">Verrouillages · 24 h</div><div class="val">${C.int(k.verrouillage)}</div></div>
      <div class="kpi ${k.bloque_politique ? 'warn' : ''}"><div class="lbl">Bloquées par la politique · 24 h</div><div class="val">${C.int(k.bloque_politique)}</div></div>
      <div class="kpi"><div class="lbl">Appareils en attente · 24 h</div><div class="val">${C.int(k.appareil_en_attente)}</div></div></div>
    <div class="card mb-14"><div class="card-h"><h3>Signaux à examiner</h3></div><div class="card-b">${C.signalsHtml(d.signaux)}</div></div>
    <div class="cons-toolbar">
      <select class="input-fld" id="aCab" aria-label="Espace"><option value="">Tous les espaces</option>${ws.rows.map(w => `<option value="${esc(w.id)}" ${f.cabinet === w.id ? 'selected' : ''}>${esc(w.slug || w.nom)}</option>`).join('')}</select>
      <select class="input-fld" id="aRes" aria-label="Résultat"><option value="">Tous les résultats</option>${Object.entries(RES).map(([v, [l]]) => `<option value="${v}" ${f.resultat === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input-fld" id="aH" aria-label="Période">${[['24', '24 heures'], ['168', '7 jours'], ['720', '30 jours'], ['', 'Tout']].map(([v, l]) => `<option value="${v}" ${f.heures === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="muted t-sm">${d.rows.length} évènement(s)</span></div>`
    + C.table(['Date', 'Espace', 'Compte', 'Résultat', 'Motif', 'IP', 'Pays', 'Appareil'], d.rows.map(r => `<tr>
      <td class="first mono">${C.fdtz(r.created_at)}</td><td data-l="Espace">${r.cabinet_id ? `<a href="#/workspace/${esc(r.cabinet_id)}/securite">${esc(r.slug || '—')}</a>` : '<span class="muted">—</span>'}</td>
      <td data-l="Compte">${esc(r.email || '—')}${r.user_role === 'admin' ? ' <span class="pill pill-sm pill-brand">admin</span>' : ''}</td>
      <td data-l="Résultat"><span class="pill pill-sm ${(RES[r.resultat] || [])[1] || ''}">${esc((RES[r.resultat] || [r.resultat])[0])}</span></td>
      <td class="wrap muted" data-l="Motif">${esc(MOTIF[r.motif] || r.motif || '—')}</td><td class="mono" data-l="IP">${esc(r.ip || '—')}</td><td data-l="Pays">${esc(r.pays || '—')}</td>
      <td data-l="Appareil">${esc([r.navigateur, r.os].filter(Boolean).join(' · ') || '—')}</td></tr>`), { empty: 'Aucun évènement pour ces filtres.' });
  for (const [id, key] of [['#aCab', 'cabinet'], ['#aRes', 'resultat'], ['#aH', 'heures']]) $(id).addEventListener('change', e => { f[key] = e.target.value; C.render(); });
};
C.wsTab('activite', 'Activité', async (el, ws) => {
  const d = await C.api('GET', `/login-activity?cabinet=${ws.id}&limit=200`);
  el.innerHTML = `<div class="card mb-14"><div class="card-h"><h3>Signaux</h3></div><div class="card-b">${C.signalsHtml(d.signaux)}</div></div>`
    + C.table(['Date', 'Compte', 'Résultat', 'Motif', 'IP', 'Pays', 'Appareil'], d.rows.map(r => `<tr><td class="first mono">${C.fdtz(r.created_at)}</td>
      <td data-l="Compte">${esc(r.email || '—')}</td><td data-l="Résultat"><span class="pill pill-sm ${(RES[r.resultat] || [])[1] || ''}">${esc((RES[r.resultat] || [r.resultat])[0])}</span></td>
      <td class="muted" data-l="Motif">${esc(MOTIF[r.motif] || r.motif || '—')}</td><td class="mono" data-l="IP">${esc(r.ip || '—')}</td><td data-l="Pays">${esc(r.pays || '—')}</td>
      <td data-l="Appareil">${esc([r.navigateur, r.os].filter(Boolean).join(' · ') || '—')}</td></tr>`), { empty: 'Aucune connexion enregistrée.' });
}, 60);
});
