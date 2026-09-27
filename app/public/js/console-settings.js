'use strict';
/* Console — réglages de la plateforme : bandeau de maintenance global (puis listes d'IP, rétention…). */
(window.DPC_EXT = window.DPC_EXT || []).push(function (C) {
const { $, esc, IC } = C;
C.settingsCards = C.settingsCards || [];
C.settingsCard = (order, render) => C.settingsCards.push({ order, render });
C.views.settings = async (el) => {
  el.innerHTML = C.pageHead('Réglages de la plateforme', 'S’appliquent à tous les espaces. Chaque modification est inscrite au journal plateforme.') + '<div class="cons-grid" id="setGrid"></div>';
  const grid = $('#setGrid');
  for (const c of C.settingsCards.slice().sort((a, b) => a.order - b.order)) {
    const box = document.createElement('div'); box.className = 'card'; grid.appendChild(box);
    try { await c.render(box, () => C.render()); } catch (e) { box.innerHTML = `<div class="card-b"><div class="note note-danger">${IC.warn}<div>${esc(e.message)}</div></div></div>`; }
  }
};
C.settingsCard(10, async (box, reload) => {
  const { maintenance: m } = await C.api('GET', '/maintenance');
  box.innerHTML = `<div class="card-h"><h3>Bandeau de maintenance global</h3></div><div class="card-b">
    <p class="t-sm m-0 mb-14">Affiché sur la page de connexion et dans l’application de <b>tous</b> les espaces, jusqu’à l’heure de fin.</p>
    ${m ? `<div class="note note-info mb-14">${IC.info}<div>${esc(m.message)}${m.fin ? ` — jusqu’au ${C.fdt(m.fin)}` : ' — sans heure de fin'}</div></div>` : '<p class="t-sm muted">Aucun bandeau actif.</p>'}
    <div class="row-12"><button class="btn btn-ghost" id="gmSet">${m ? 'Modifier' : 'Afficher un bandeau'}</button>${m ? '<button class="btn btn-quiet" id="gmDel">Retirer</button>' : ''}</div></div>`;
  $('#gmSet', box).addEventListener('click', async () => {
    const v = await C.dialog({ title: 'Bandeau de maintenance global', fields: [
      { name: 'message', label: 'Message', type: 'textarea', required: true, value: m ? m.message : '', max: 300 },
      { name: 'fin', label: 'Fin (le bandeau disparaît automatiquement)', type: 'datetime-local' }], confirm: 'Afficher partout' });
    if (!v) return;
    try { await C.api('PUT', '/maintenance', { message: v.message, fin: v.fin ? new Date(v.fin).toISOString() : null }); C.toast('Bandeau global affiché.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  });
  const d = $('#gmDel', box); if (d) d.addEventListener('click', async () => { await C.api('DELETE', '/maintenance'); C.toast('Bandeau retiré.'); reload(); });
});
});
