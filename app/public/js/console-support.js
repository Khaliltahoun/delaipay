'use strict';
/* Console — onglet « Assistance » : accès temporaire, en lecture seule, visible par l'espace. */
(window.DPC_EXT = window.DPC_EXT || []).push(function (C) {
const { $, $$, esc, IC } = C;
C.wsTab('assistance', 'Assistance', async (el, ws, reload) => {
  const d = await C.api('GET', `/workspaces/${ws.id}/support`);
  const active = d.rows.filter(a => a.actif);
  el.innerHTML = `<div class="cons-grid"><div class="card"><div class="card-h"><h3>Ouvrir un accès d’assistance</h3></div><div class="card-b">
      <div class="note note-info mb-14">${IC.info}<div>La console n’affiche jamais les données de l’espace. Un accès d’assistance ouvre l’espace <b>en lecture seule</b> (rôle « Lecture seule », aucune modification possible), pour une durée limitée à ${d.maxMinutes / 60} heures. Il est inscrit au journal de l’espace, visible par son administrateur, et se termine automatiquement.</div></div>
      ${ws.statut === 'suspendu' || ws.statut === 'supprime' ? `<p class="t-sm muted">Indisponible : espace ${esc(ws.statutLabel.toLowerCase())}.</p>` : `
      <div class="fld"><label class="fld-lbl" for="s_motif">Motif (visible par l’administrateur de l’espace)</label><textarea class="input-fld" id="s_motif" rows="2" maxlength="500" placeholder="Ex. : ticket #1234 — écart de total sur la déclaration T1"></textarea></div>
      <div class="fld"><label class="fld-lbl" for="s_dur">Durée</label><select class="input-fld" id="s_dur" style="max-width:220px">${[[15, '15 minutes'], [30, '30 minutes'], [60, '1 heure'], [120, '2 heures (maximum)']].map(([v, l]) => `<option value="${v}" ${v === 30 ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <button class="btn btn-primary" id="s_open">Ouvrir l’accès en lecture seule</button><div id="s_out"></div>`}
    </div></div>
    <div class="card"><div class="card-h"><h3>Accès en cours (${active.length})</h3></div><div class="card-b">${active.length ? active.map(a => `<div class="note note-warn mb-14">${IC.lock}<div><div class="note-t">${esc(a.admin)} · jusqu’au ${C.fdt(a.fin)}</div>${esc(a.motif)}
        <div class="row-12 mt-8"><button class="btn btn-ghost btn-xs" data-link="${esc(a.id)}">${IC.out}Nouveau lien d’ouverture</button><button class="btn btn-danger-ghost btn-xs" data-end="${esc(a.id)}">Terminer maintenant</button></div></div></div>`).join('') : '<p class="t-sm muted m-0">Aucun accès en cours.</p>'}</div></div>
    <div class="card span-2"><div class="card-h"><h3>Historique</h3></div><div class="card-b" style="padding:0">${C.table(['Ouvert par', 'Motif', 'Début', 'Fin prévue', 'Fin effective', 'Statut'], d.rows.map(a => `<tr>
      <td class="first">${esc(a.admin)}</td><td class="wrap" data-l="Motif">${esc(a.motif)}</td><td class="mono" data-l="Début">${C.fdt(a.debut)}</td><td class="mono" data-l="Fin prévue">${C.fdt(a.fin)}</td>
      <td class="mono" data-l="Fin">${a.finEffective ? `${C.fdt(a.finEffective)} <span class="muted t-xs">${esc(a.finMotif || '')}</span>` : '—'}</td>
      <td data-l="Statut">${a.actif ? '<span class="pill pill-sm pill-warn">En cours</span>' : '<span class="pill pill-sm pill-locked">Terminé</span>'}</td></tr>`), { empty: 'Aucun accès d’assistance.' })}</div></div></div>`;
  const showLink = (r) => C.showOnce('Lien d’ouverture de l’accès d’assistance', C.onceBox('Ouvrir dans un nouvel onglet', r.lien, `Usage unique, valable 2 minutes. Accès jusqu’au ${C.fdt(r.fin)}.`)
    + `<p class="mt-14 m-0"><a class="btn btn-primary" href="${esc(r.lien)}" target="_blank" rel="noopener noreferrer">${IC.out}Ouvrir l’espace en lecture seule</a></p>`);
  const open = $('#s_open');
  if (open) open.addEventListener('click', async () => {
    const motif = $('#s_motif').value.trim();
    try { const r = await C.api('POST', `/workspaces/${ws.id}/support`, { motif, dureeMinutes: +$('#s_dur').value }); await showLink(r); reload(); }
    catch (e) { C.toast(e.message, 'err'); }
  });
  $$('[data-link]', el).forEach(b => b.addEventListener('click', async () => { try { showLink(await C.api('POST', `/support/${b.dataset.link}/link`, {})); } catch (e) { C.toast(e.message, 'err'); } }));
  $$('[data-end]', el).forEach(b => b.addEventListener('click', async () => {
    const v = await C.dialog({ title: 'Terminer l’accès d’assistance ?', body: '<p class="t-sm">La session d’assistance est fermée immédiatement.</p>', confirm: 'Terminer' });
    if (!v) return;
    try { await C.api('POST', `/support/${b.dataset.end}/end`, {}); C.toast('Accès terminé.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  }));
}, 70);
});
