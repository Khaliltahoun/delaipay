'use strict';
/* Console — espaces de travail : liste, création, fiche (onglets extensibles par les autres modules). */
(window.DPC_EXT = window.DPC_EXT || []).push(function (C) {
const { $, $$, esc, IC } = C;

const STATUT_PILL = { actif: 'pill-ok', suspendu: 'pill-locked', expire: 'pill-warn', supprime: 'pill-late' };
C.statutPill = (s, label) => `<span class="pill pill-sm ${STATUT_PILL[s] || ''}">${esc(label || s)}</span>`;
const PAY = { paye: ['Payé', 'pill-ok'], en_attente: ['En attente', 'pill-app'], en_retard: ['En retard', 'pill-late'] };
const PLANS = [['essentiel', 'Essentiel'], ['pro', 'Pro'], ['cabinet', 'Cabinet'], ['sur_mesure', 'Sur mesure']];
function aboCell(a) {
  if (!a || !a.date_fin) return '<span class="muted">Non renseigné</span>';
  const warn = a.etat === 'bientot' ? ` <span class="pill pill-sm pill-app">dans ${a.jours_restants} j</span>`
    : a.etat === 'grace' ? ` <span class="pill pill-sm pill-warn">échu · grâce jusqu’au ${C.fd(a.fin_grace)}</span>`
    : a.etat === 'lecture_seule' ? ' <span class="pill pill-sm pill-locked">lecture seule</span>' : '';
  return `${C.fd(a.date_debut)} → <b>${C.fd(a.date_fin)}</b>${warn}`;
}
C.aboCell = aboCell;
const lim = (n, max) => `${C.int(n)}${max != null ? ` <span class="muted">/ ${max}</span>` : ''}`;

/* ------------------------------------------------------------------ liste */
let listState = { q: '', statut: '', sort: 'nom', dir: 1 };
C.views.workspaces = async (el) => {
  const d = await C.api('GET', '/workspaces');
  el.innerHTML = C.pageHead('Espaces de travail', 'Un espace = un cabinet client (sous-domaine). Métadonnées et compteurs uniquement : aucune donnée comptable n’est affichée ici.',
    `<button class="btn btn-primary" id="newWs">${IC.plus}Nouvel espace</button>`)
    + `<div class="cons-toolbar">
      <input class="input-fld" id="wsQ" type="search" placeholder="Rechercher un nom ou un identifiant…" value="${esc(listState.q)}" aria-label="Rechercher">
      <select class="input-fld" id="wsSt" aria-label="Filtrer par statut"><option value="">Tous les statuts</option>
        ${[['actif', 'Actifs'], ['suspendu', 'Suspendus'], ['expire', 'Expirés'], ['supprime', 'Supprimés']].map(([v, l]) => `<option value="${v}" ${listState.statut === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input-fld" id="wsSort" aria-label="Trier">${[['nom', 'Nom'], ['derniereActivite', 'Dernière activité'], ['fin', 'Échéance d’abonnement'], ['utilisateurs', 'Utilisateurs'], ['factures', 'Factures'], ['empreinte', 'Empreinte']].map(([v, l]) => `<option value="${v}" ${listState.sort === v ? 'selected' : ''}>Tri : ${l}</option>`).join('')}</select>
      <span class="muted t-sm" id="wsCount"></span></div><div id="wsTable"></div>`;
  const draw = () => {
    const q = listState.q.toLowerCase();
    let rows = d.rows.filter(r => (!listState.statut || r.statut === listState.statut) && (!q || `${r.nom} ${r.nomAffiche || ''} ${r.slug || ''}`.toLowerCase().includes(q)));
    const key = { nom: r => (r.nomAffiche || r.nom || '').toLowerCase(), derniereActivite: r => r.derniereActivite || '', fin: r => (r.abonnement && r.abonnement.date_fin) || '9999',
      utilisateurs: r => r.utilisateurs, factures: r => r.factures, empreinte: r => r.empreinte ? r.empreinte.total : 0 }[listState.sort];
    const desc = ['derniereActivite', 'utilisateurs', 'factures', 'empreinte'].includes(listState.sort) ? -1 : 1;
    rows = rows.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * desc);
    $('#wsCount').textContent = `${rows.length} espace${rows.length > 1 ? 's' : ''}`;
    $('#wsTable').innerHTML = C.table([
      'Espace', 'Statut', 'Formule', 'Abonnement', { label: 'Utilisateurs', num: true }, { label: 'Clients', num: true },
      { label: 'Factures', num: true }, 'Dernière activité', { label: 'Sessions', num: true }, { label: 'Empreinte', num: true }],
      rows.map(r => `<tr>
        <td class="first"><a class="rowlink" href="#/workspace/${esc(r.id)}">${esc(r.nomAffiche || r.nom)}</a> <span class="muted mono t-xs">${esc(r.slug || '—')}</span></td>
        <td data-l="Statut">${C.statutPill(r.statut, r.statutLabel)}</td><td data-l="Formule">${esc(r.planLabel || '—')}</td>
        <td data-l="Abonnement">${aboCell(r.abonnement)}</td>
        <td class="num" data-l="Utilisateurs">${lim(r.utilisateurs, r.limites.maxUtilisateurs)}${r.invitations ? ` <span class="muted t-xs">+${r.invitations} inv.</span>` : ''}</td>
        <td class="num" data-l="Clients">${lim(r.clients, r.limites.maxClients)}</td><td class="num" data-l="Factures">${C.int(r.factures)}</td>
        <td data-l="Activité">${C.ago(r.derniereActivite)}</td><td class="num" data-l="Sessions">${C.int(r.sessionsActives)}</td>
        <td class="num muted" data-l="Empreinte">${C.bytes(r.empreinte && r.empreinte.total)}</td></tr>`),
      { empty: listState.q || listState.statut ? 'Aucun espace ne correspond à ces filtres.' : 'Aucun espace pour le moment.' });
  };
  draw();
  $('#wsQ').addEventListener('input', e => { listState.q = e.target.value; draw(); });
  $('#wsSt').addEventListener('change', e => { listState.statut = e.target.value; draw(); });
  $('#wsSort').addEventListener('change', e => { listState.sort = e.target.value; draw(); });
  $('#newWs').addEventListener('click', () => C.go('workspace-new'));
};

/* ------------------------------------------------------------------ création */
const fld = (id, label, { type = 'text', req = false, help = '', ph = '', val = '', attrs = '' } = {}) =>
  `<div class="fld"><label class="fld-lbl" for="${id}">${esc(label)}${req ? '' : ' <span class="muted t-xs">(facultatif)</span>'}</label>
   <input class="input-fld" id="${id}" type="${type}" placeholder="${esc(ph)}" value="${esc(val)}" ${attrs}>${help ? `<small class="fld-help" id="${id}_h">${esc(help)}</small>` : ''}</div>`;
const sel = (id, label, opts, val) => `<div class="fld"><label class="fld-lbl" for="${id}">${esc(label)}</label><select class="input-fld" id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
C.fld = fld; C.sel = sel;
C.views['workspace-new'] = async (el) => {
  el.innerHTML = C.pageHead('Nouvel espace de travail', 'Crée l’espace et invite son premier administrateur, en une seule opération. Le mot de passe est choisi par l’administrateur lui-même.',
    `<button class="btn btn-ghost" id="back">${IC.back}Espaces</button>`)
    + `<form id="wsForm" novalidate><div class="cons-grid">
    <div class="card"><div class="card-h"><h3>Identité</h3></div><div class="card-b">
      ${fld('f_nom', 'Nom du cabinet', { req: true, ph: 'Prime Conseil' })}
      ${fld('f_slug', 'Identifiant (sous-domaine)', { req: true, ph: 'prime', help: 'Lettres minuscules, chiffres et tirets.', attrs: 'autocomplete="off" spellcheck="false"' })}
      ${fld('f_raison', 'Raison sociale', { ph: 'PRIME CONSEIL SARL' })}${fld('f_adresse', 'Adresse')}
      <div class="grid-2">${fld('f_if', 'Identifiant fiscal (IF)', { attrs: 'inputmode="numeric"' })}${fld('f_ice', 'ICE', { help: '15 chiffres', attrs: 'inputmode="numeric" maxlength="15"' })}</div>
    </div></div>
    <div class="card"><div class="card-h"><h3>Contact et marque</h3></div><div class="card-b">
      ${fld('f_cnom', 'Nom du contact')}${fld('f_cmail', 'E-mail du contact', { type: 'email' })}${fld('f_ctel', 'Téléphone')}
      <div class="grid-2"><div class="fld"><label class="fld-lbl" for="f_color">Couleur de l’espace <span class="muted t-xs">(facultatif)</span></label><input class="input-fld" id="f_color" type="color" value="#2F3E6B"><label class="check mt-8"><input type="checkbox" id="f_nocolor"> Sans couleur</label></div>
      <div class="fld"><label class="fld-lbl" for="f_logo">Logo <span class="muted t-xs">(PNG, JPEG, WebP · 1 Mo)</span></label><input class="input-fld" id="f_logo" type="file" accept="image/png,image/jpeg,image/webp"></div></div>
    </div></div>
    <div class="card"><div class="card-h"><h3>Formule et limites</h3></div><div class="card-b">
      ${sel('f_plan', 'Formule', PLANS, 'pro')}
      <div class="grid-2">${fld('f_maxu', 'Utilisateurs au maximum', { type: 'number', attrs: 'min="1"' })}${fld('f_maxc', 'Dossiers clients au maximum', { type: 'number', attrs: 'min="1"' })}</div>
      <small class="fld-help">Vide = sans limite. Contrôlées par le serveur (invitation, création de compte, réactivation, nouveau dossier).</small>
    </div></div>
    <div class="card"><div class="card-h"><h3>Abonnement (facturation manuelle)</h3></div><div class="card-b">
      <div class="grid-2">${fld('f_deb', 'Début', { type: 'date' })}${fld('f_fin', 'Renouvellement / fin', { type: 'date' })}</div>
      <div class="grid-2">${fld('f_mt', 'Montant (DH HT)', { attrs: 'inputmode="decimal"' })}${sel('f_pay', 'Paiement', [['en_attente', 'En attente'], ['paye', 'Payé'], ['en_retard', 'En retard']], 'en_attente')}</div>
    </div></div>
    <div class="card span-2"><div class="card-h"><h3>Premier administrateur</h3></div><div class="card-b">
      ${fld('f_admin', 'E-mail du premier administrateur', { type: 'email', req: true, ph: 'direction@prime.ma', help: 'Un lien d’invitation à usage unique (valable 7 jours) sera affiché une seule fois, à lui transmettre.' })}
      <div class="fld-err hidden" id="f_err" role="alert"></div>
      <div class="row-12"><button class="btn btn-primary" type="submit" id="f_go">Créer l’espace et l’invitation</button><button class="btn btn-ghost" type="button" id="f_cancel">Annuler</button></div>
    </div></div></div></form><div id="created"></div>`;
  $('#back').addEventListener('click', () => C.go('workspaces'));
  $('#f_cancel').addEventListener('click', () => C.go('workspaces'));
  let t = null, touched = false;
  const slugify = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const check = () => { clearTimeout(t); t = setTimeout(async () => {
    const v = $('#f_slug').value.trim(); const h = $('#f_slug_h'); if (!v) { h.textContent = 'Lettres minuscules, chiffres et tirets.'; return; }
    const r = await C.api('GET', '/workspaces/check-slug?slug=' + encodeURIComponent(v)).catch(() => null);
    if (!r) return;
    h.textContent = r.ok ? `Adresse : ${r.adresse}` : r.error; h.className = r.ok ? 'fld-help' : 'fld-err';
    $('#f_slug').setAttribute('aria-invalid', String(!r.ok));
  }, 250); };
  $('#f_nom').addEventListener('input', e => { if (!touched) { $('#f_slug').value = slugify(e.target.value); check(); } });
  $('#f_slug').addEventListener('input', () => { touched = true; check(); });
  $('#wsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = id => $(id).value.trim();
    const body = { nom: v('#f_nom'), slug: v('#f_slug'), raisonLegale: v('#f_raison'), adresse: v('#f_adresse'), ifFiscal: v('#f_if'), ice: v('#f_ice'),
      contactNom: v('#f_cnom'), contactEmail: v('#f_cmail'), contactTelephone: v('#f_ctel'), couleur: $('#f_nocolor').checked ? null : $('#f_color').value,
      plan: v('#f_plan'), maxUtilisateurs: v('#f_maxu') || null, maxClients: v('#f_maxc') || null, adminEmail: v('#f_admin'),
      abonnement: { date_debut: v('#f_deb') || null, date_fin: v('#f_fin') || null, montant: v('#f_mt') || null, statut_paiement: v('#f_pay') } };
    const errEl = $('#f_err'); errEl.classList.add('hidden');
    if (!body.nom || !body.slug || !body.adminEmail) { errEl.textContent = 'Nom, identifiant et e-mail du premier administrateur sont obligatoires.'; errEl.classList.remove('hidden'); return; }
    $('#f_go').disabled = true;
    try {
      const r = await C.api('POST', '/workspaces', body);
      const file = $('#f_logo').files[0];
      let logoMsg = '';
      if (file) {
        const fd = new FormData(); fd.append('file', file);
        const lr = await fetch(`/api/platform/workspaces/${r.id}/logo`, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-DP-Console': '1' } });
        if (!lr.ok) logoMsg = `<div class="note note-warn mt-8">${IC.warn}<div>Espace créé, mais logo refusé : ${esc((await lr.json().catch(() => ({}))).error || 'format non accepté')}.</div></div>`;
      }
      $('#wsForm').classList.add('hidden');
      $('#created').innerHTML = `<div class="card"><div class="card-h"><h3>Espace « ${esc(r.slug)} » créé</h3></div><div class="card-b">
        <p class="t-sm m-0">Adresse de l’espace : <a href="${esc(r.adresse)}/login" target="_blank" rel="noopener">${esc(r.adresse)}</a></p>
        ${C.onceBox(`Lien d’invitation de ${r.invitation.email}`, r.invitation.lien, `Affiché une seule fois. Valable jusqu’au ${C.fdt(r.invitation.expire)}. Transmettez-le par un canal sûr ; il ouvre la création du compte administrateur.`)}
        ${r.abonnementErreur ? `<div class="note note-warn">${IC.warn}<div>Abonnement non enregistré : ${esc(r.abonnementErreur)}</div></div>` : ''}${logoMsg}
        <div class="row-12 mt-14"><button class="btn btn-primary" id="openWs">Ouvrir la fiche de l’espace</button><button class="btn btn-ghost" id="otherWs">Créer un autre espace</button></div>
      </div></div>`;
      $('#openWs').addEventListener('click', () => C.go('workspace', r.id));
      $('#otherWs').addEventListener('click', () => C.render());
    } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); $('#f_go').disabled = false; }
  });
};

/* ------------------------------------------------------------------ fiche */
// Onglets extensibles : { key, label, render(el, ws, reload) } — les phases suivantes en ajoutent.
C.wsTabs = C.wsTabs || [];
const tab = (key, label, render, order) => { C.wsTabs.push({ key, label, render, order }); };
C.wsTab = tab;
C.views.workspace = async (el, params) => {
  const [id, tabKey = 'apercu'] = params;
  const ws = await C.api('GET', '/workspaces/' + encodeURIComponent(id));
  const tabs = C.wsTabs.slice().sort((a, b) => a.order - b.order);
  const cur = tabs.find(t => t.key === tabKey) || tabs[0];
  el.innerHTML = C.pageHead(ws.nomAffiche || ws.nom, `<span class="mono">${esc(ws.slug || '—')}</span> · ${C.statutPill(ws.statut, ws.statutLabel)} · formule ${esc(ws.planLabel || '—')}${ws.adresse ? ` · <a href="${esc(ws.adresse)}/login" target="_blank" rel="noopener">${esc(ws.adresse.replace(/^https?:\/\//, ''))}</a>` : ''}`,
    `<button class="btn btn-ghost" id="back">${IC.back}Espaces</button>`)
    + `<div class="tabs" role="tablist">${tabs.map(t => `<button class="tab" role="tab" aria-selected="${t === cur}" data-tab="${t.key}">${esc(t.label)}</button>`).join('')}</div><div id="tabBody"></div>`;
  $('#back').addEventListener('click', () => C.go('workspaces'));
  $$('.tab', el).forEach(b => b.addEventListener('click', () => C.go('workspace', id, b.dataset.tab)));
  await cur.render($('#tabBody'), ws, () => C.render());
};

tab('apercu', 'Aperçu', async (el, ws, reload) => {
  const i = ws.identite;
  const warn = [];
  if (ws.suspension) warn.push(`<div class="note note-locked">${IC.lock}<div><div class="note-t">Espace suspendu le ${C.fdt(ws.suspension.le)}</div>Motif : ${esc(ws.suspension.motif || '—')}</div></div>`);
  if (ws.suppression) warn.push(`<div class="note note-danger">${IC.warn}<div><div class="note-t">Espace supprimé le ${C.fdt(ws.suppression.le)}</div>Données conservées ; purge manuelle possible après le ${C.fd(ws.suppression.purgeApres)}. Motif : ${esc(ws.suppression.motif || '—')}</div></div>`);
  if (ws.abonnement && ws.abonnement.etat === 'bientot') warn.push(`<div class="note note-info">${IC.info}<div>Renouvellement dans ${ws.abonnement.jours_restants} jour(s), le ${C.fd(ws.abonnement.date_fin)}.</div></div>`);
  if (ws.abonnement && ws.abonnement.etat === 'grace') warn.push(`<div class="note note-warn">${IC.warn}<div>Abonnement échu le ${C.fd(ws.abonnement.date_fin)} — accès complet jusqu’au ${C.fd(ws.abonnement.fin_grace)}, puis lecture seule.</div></div>`);
  if (ws.abonnement && ws.abonnement.etat === 'lecture_seule') warn.push(`<div class="note note-locked">${IC.lock}<div>Abonnement échu : l’espace est en lecture seule depuis le ${C.fd(ws.abonnement.fin_grace)}.</div></div>`);
  if (ws.maintenance) warn.push(`<div class="note note-info">${IC.info}<div><div class="note-t">Bandeau de maintenance actif</div>${esc(ws.maintenance.message)}${ws.maintenance.fin ? ` — jusqu’au ${C.fdt(ws.maintenance.fin)}` : ''}</div></div>`);
  if (ws.invitationAdmin && !ws.invitationAdmin.accepted_at && ws.utilisateursTotal === 0) warn.push(`<div class="note note-warn">${IC.warn}<div><div class="note-t">Premier administrateur pas encore inscrit</div>Invitation envoyée à ${esc(ws.invitationAdmin.email)}, ${ws.invitationAdmin.revoked_at ? 'révoquée' : `valable jusqu’au ${C.fdt(ws.invitationAdmin.expires_at)}`}. Une nouvelle invitation peut être créée dans « Cycle de vie ».</div></div>`);
  el.innerHTML = `${warn.length ? `<div class="stack mb-14" style="display:grid;gap:8px">${warn.join('')}</div>` : ''}
    <div class="kpi-grid">
      <div class="kpi"><div class="lbl">Utilisateurs actifs</div><div class="val">${lim(ws.utilisateurs, ws.limites.maxUtilisateurs)}</div><div class="sub">${ws.invitations} invitation(s) en attente</div></div>
      <div class="kpi"><div class="lbl">Dossiers clients</div><div class="val">${lim(ws.clients, ws.limites.maxClients)}</div></div>
      <div class="kpi"><div class="lbl">Factures</div><div class="val">${C.int(ws.factures)}</div></div>
      <div class="kpi"><div class="lbl">Sessions actives</div><div class="val">${C.int(ws.sessionsActives)}</div><div class="sub">activité : ${C.ago(ws.derniereActivite)}</div></div>
      <div class="kpi"><div class="lbl">Empreinte</div><div class="val">${C.bytes(ws.empreinte.total)}</div><div class="sub">base ${C.bytes(ws.empreinte.base)} · fichiers ${C.bytes(ws.empreinte.fichiers)}</div></div>
    </div>
    <div class="cons-grid"><div class="card"><div class="card-h"><h3>Identité</h3><button class="btn btn-ghost btn-sm" id="editId">Modifier</button></div><div class="card-b"><dl class="dl-ops">
      <dt>Nom</dt><dd>${esc(i.nom)}</dd><dt>Nom affiché</dt><dd>${esc(i.nomAffiche || '—')}</dd><dt>Raison sociale</dt><dd>${esc(i.raisonLegale || '—')}</dd>
      <dt>Adresse</dt><dd>${esc(i.adresse || '—')}</dd><dt>IF</dt><dd class="mono">${esc(i.ifFiscal || '—')}</dd><dt>ICE</dt><dd class="mono">${esc(i.ice || '—')}</dd>
      <dt>Couleur</dt><dd>${i.couleur ? `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${esc(i.couleur)};vertical-align:-1px"></span> <span class="mono">${esc(i.couleur)}</span>` : '—'}</dd>
      <dt>Logo</dt><dd>${i.hasLogo ? 'Oui' : '—'} <label class="btn btn-quiet btn-xs" style="cursor:pointer">Remplacer<input type="file" id="logoIn" accept="image/png,image/jpeg,image/webp" class="sr-only"></label></dd>
    </dl></div></div>
    <div class="card"><div class="card-h"><h3>Contact et limites</h3></div><div class="card-b"><dl class="dl-ops">
      <dt>Contact</dt><dd>${esc(i.contactNom || '—')}</dd><dt>E-mail</dt><dd>${esc(i.contactEmail || '—')}</dd><dt>Téléphone</dt><dd>${esc(i.contactTelephone || '—')}</dd>
      <dt>Utilisateurs max.</dt><dd>${ws.limites.maxUtilisateurs == null ? 'Sans limite' : ws.limites.maxUtilisateurs}</dd><dt>Dossiers max.</dt><dd>${ws.limites.maxClients == null ? 'Sans limite' : ws.limites.maxClients}</dd>
      <dt>Hôtes</dt><dd class="mono t-xs">${ws.hotes.map(esc).join('<br>') || '—'}</dd><dt>Créé le</dt><dd>${C.fdt(ws.createdAt)}</dd>
    </dl></div></div></div>`;
  $('#editId').addEventListener('click', async () => {
    const v = await C.dialog({ title: 'Modifier l’identité de l’espace', wide: true, fields: [
      { name: 'nom', label: 'Nom du cabinet', required: true, value: i.nom }, { name: 'nomAffiche', label: 'Nom affiché', value: i.nomAffiche },
      { name: 'raisonLegale', label: 'Raison sociale', value: i.raisonLegale }, { name: 'adresse', label: 'Adresse', value: i.adresse },
      { name: 'ifFiscal', label: 'Identifiant fiscal', value: i.ifFiscal }, { name: 'ice', label: 'ICE (15 chiffres)', value: i.ice },
      { name: 'contactNom', label: 'Nom du contact', value: i.contactNom }, { name: 'contactEmail', label: 'E-mail du contact', value: i.contactEmail },
      { name: 'contactTelephone', label: 'Téléphone', value: i.contactTelephone }, { name: 'couleur', label: 'Couleur (#RRGGBB)', value: i.couleur },
      { name: 'maxUtilisateurs', label: 'Utilisateurs au maximum (vide = sans limite)', type: 'number', value: ws.limites.maxUtilisateurs },
      { name: 'maxClients', label: 'Dossiers clients au maximum (vide = sans limite)', type: 'number', value: ws.limites.maxClients },
      { name: 'plan', label: 'Formule', type: 'select', value: ws.plan, options: PLANS.map(([value, label]) => ({ value, label })) },
    ], confirm: 'Enregistrer' });
    if (!v) return;
    try { await C.api('PATCH', '/workspaces/' + ws.id, v); C.toast('Identité enregistrée (journalisée avant → après).'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  });
  $('#logoIn').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    const r = await fetch(`/api/platform/workspaces/${ws.id}/logo`, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-DP-Console': '1' } });
    const d = await r.json().catch(() => ({}));
    if (r.ok) { C.toast('Logo remplacé.'); reload(); } else C.toast(d.error || 'Logo refusé.', 'err');
  });
}, 10);

tab('abonnement', 'Abonnement', async (el, ws, reload) => {
  const a = ws.abonnementComplet || {};
  el.innerHTML = `<div class="cons-grid"><div class="card"><div class="card-h"><h3>Abonnement — facturation manuelle</h3></div><div class="card-b">
    <form id="aboForm" novalidate>
      ${sel('a_plan', 'Formule', PLANS, a.plan || ws.plan || 'pro')}
      <div class="grid-2">${fld('a_deb', 'Début', { type: 'date', val: a.date_debut || '' })}${fld('a_fin', 'Renouvellement / fin', { type: 'date', val: a.date_fin || '' })}</div>
      <div class="grid-2">${fld('a_mt', 'Montant (DH HT)', { val: a.montant == null ? '' : String(a.montant).replace('.', ','), attrs: 'inputmode="decimal"' })}
        ${sel('a_per', 'Périodicité', [['', '—'], ['mensuel', 'Mensuel'], ['trimestriel', 'Trimestriel'], ['annuel', 'Annuel']], a.periodicite || '')}</div>
      <div class="grid-2">${sel('a_pay', 'Paiement', [['en_attente', 'En attente'], ['paye', 'Payé'], ['en_retard', 'En retard']], a.statut_paiement || 'en_attente')}
        ${fld('a_grace', 'Délai de grâce après l’échéance (jours)', { type: 'number', val: a.grace_jours == null ? 15 : a.grace_jours, attrs: 'min="0" max="180"' })}</div>
      <div class="fld"><label class="fld-lbl" for="a_notes">Notes internes <span class="muted t-xs">(facultatif)</span></label><textarea class="input-fld" id="a_notes" rows="3" maxlength="1000">${esc(a.notes || '')}</textarea></div>
      <button class="btn btn-primary" type="submit">Enregistrer l’abonnement</button>
    </form></div></div>
    <div class="card"><div class="card-h"><h3>Règles</h3></div><div class="card-b t-sm">
      <p class="m-0">• Échéance dans 30 jours ou moins : signalée ici, sur la liste et au tableau de bord (et aux administrateurs de l’espace).</p>
      <p>• Échéance dépassée : accès complet pendant le délai de grâce, avec un bandeau pour tous les utilisateurs.</p>
      <p>• Délai de grâce écoulé : l’espace passe en <b>lecture seule</b> (consultation et exports). Aucune donnée n’est jamais supprimée automatiquement.</p>
      <p class="m-0">État actuel : ${ws.abonnement ? aboCell(ws.abonnement) : '<span class="muted">non renseigné</span>'} ${a.statut_paiement ? `<span class="pill pill-sm ${PAY[a.statut_paiement][1]}">${PAY[a.statut_paiement][0]}</span>` : ''}</p>
    </div></div></div>`;
  $('#aboForm').addEventListener('submit', async e => {
    e.preventDefault();
    const v = id => $(id).value.trim();
    try {
      await C.api('PUT', `/workspaces/${ws.id}/subscription`, { plan: v('#a_plan'), date_debut: v('#a_deb') || null, date_fin: v('#a_fin') || null,
        montant: v('#a_mt').replace(/\s/g, '').replace(',', '.') || null, periodicite: v('#a_per') || null, statut_paiement: v('#a_pay'), grace_jours: v('#a_grace'), notes: v('#a_notes') });
      C.toast('Abonnement enregistré.'); reload();
    } catch (err) { C.toast(err.message, 'err'); }
  });
}, 20);

tab('journal', 'Journal', async (el, ws) => {
  el.innerHTML = `<p class="t-sm muted m-0 mb-14">Actions de la console sur cet espace (journal plateforme, lecture seule). Les actions visibles par l’espace sont aussi inscrites à son propre journal d’audit.</p>` + C.auditTable(ws.journal || []);
}, 80);

tab('cycle', 'Cycle de vie', async (el, ws, reload) => {
  const deleted = ws.statut === 'supprime', suspended = ws.statut === 'suspendu';
  const ex = ws.dernierExport;
  const exFresh = ex && (Date.now() - new Date(String(ex.le).replace(' ', 'T') + 'Z')) < 24 * 3600e3;
  el.innerHTML = `<div class="cons-grid">
    <div class="card"><div class="card-h"><h3>Bandeau de maintenance de l’espace</h3></div><div class="card-b">
      ${ws.maintenance ? `<div class="note note-info mb-14">${IC.info}<div>${esc(ws.maintenance.message)}${ws.maintenance.fin ? ` — jusqu’au ${C.fdt(ws.maintenance.fin)}` : ''}</div></div>` : '<p class="t-sm muted m-0 mb-14">Aucun bandeau actif.</p>'}
      <div class="row-12"><button class="btn btn-ghost" id="mSet">${ws.maintenance ? 'Modifier' : 'Afficher un bandeau'}</button>${ws.maintenance ? '<button class="btn btn-quiet" id="mDel">Retirer</button>' : ''}</div>
    </div></div>
    <div class="card"><div class="card-h"><h3>${suspended ? 'Réactiver l’espace' : 'Suspendre l’espace'}</h3></div><div class="card-b">
      <p class="t-sm m-0 mb-14">${suspended ? 'Les utilisateurs pourront de nouveau se connecter.' : 'Toutes les sessions sont fermées immédiatement ; les utilisateurs voient « Cet espace de travail est suspendu ». Aucune donnée n’est modifiée.'}</p>
      ${deleted ? '<p class="t-sm muted m-0">Indisponible : espace supprimé.</p>' : `<button class="btn ${suspended ? 'btn-primary' : 'btn-danger-ghost'}" id="susp">${suspended ? 'Réactiver…' : 'Suspendre…'}</button>`}
    </div></div>
    <div class="card"><div class="card-h"><h3>Premier administrateur</h3></div><div class="card-b">
      <p class="t-sm m-0 mb-14">Nouvelle invitation d’administrateur, uniquement si l’espace n’a encore aucun administrateur actif (lien perdu ou expiré).</p>
      <button class="btn btn-ghost" id="reinv" ${deleted ? 'disabled' : ''}>Créer une invitation d’administrateur…</button><div id="reinvOut"></div>
    </div></div>
    <div class="card"><div class="card-h"><h3>${deleted ? 'Restaurer l’espace' : 'Supprimer l’espace'}</h3></div><div class="card-b">
      ${deleted ? `<p class="t-sm m-0 mb-14">Supprimé le ${C.fdt(ws.suppression.le)} ; purge manuelle possible après le ${C.fd(ws.suppression.purgeApres)}. La restauration remet l’espace <b>suspendu</b>.</p><button class="btn btn-primary" id="restore">Restaurer…</button>`
      : `<ol class="t-sm" style="margin:0 0 12px 18px;padding:0"><li>Exporter les données (fichier écrit sur le serveur, jamais affiché ici).</li><li>Supprimer : saisie de l’identifiant et motif. L’espace devient inaccessible ; les données restent jusqu’à la purge manuelle (${30} jours minimum).</li></ol>
        <div class="row-12"><button class="btn btn-ghost" id="exp">1. Exporter les données</button><button class="btn btn-danger-ghost" id="del" ${exFresh ? '' : 'disabled title="Export de moins de 24 h requis"'}>2. Supprimer…</button></div>
        ${ex ? `<div class="t-xs muted mt-8">Dernier export : ${C.fdt(ex.le)} · <span class="mono">${esc(ex.fichier)}</span> · ${C.bytes(ex.taille)} · sha256 <span class="mono">${esc(ex.sha256.slice(0, 16))}…</span>${exFresh ? '' : ' (plus de 24 h : à refaire)'}</div>` : ''}`}
      <div id="expOut"></div>
    </div></div></div>`;
  $('#mSet').addEventListener('click', async () => {
    const v = await C.dialog({ title: 'Bandeau de maintenance de l’espace', fields: [
      { name: 'message', label: 'Message affiché aux utilisateurs', type: 'textarea', required: true, value: ws.maintenance ? ws.maintenance.message : '', max: 300 },
      { name: 'fin', label: 'Fin (le bandeau disparaît automatiquement)', type: 'datetime-local' }], confirm: 'Afficher' });
    if (!v) return;
    try { await C.api('PUT', `/workspaces/${ws.id}/maintenance`, { message: v.message, fin: v.fin ? new Date(v.fin).toISOString() : null }); C.toast('Bandeau affiché.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  });
  if ($('#mDel')) $('#mDel').addEventListener('click', async () => { await C.api('DELETE', `/workspaces/${ws.id}/maintenance`); C.toast('Bandeau retiré.'); reload(); });
  if ($('#susp')) $('#susp').addEventListener('click', async () => {
    const v = await C.dialog({ title: suspended ? `Réactiver « ${ws.slug} » ?` : `Suspendre « ${ws.slug} » ?`, danger: !suspended,
      body: suspended ? '' : `<p class="t-sm">${ws.sessionsActives} session(s) active(s) seront fermées.</p>`,
      fields: [{ name: 'motif', label: 'Motif (inscrit aux journaux de la plateforme et de l’espace)', type: 'textarea', required: true }], confirm: suspended ? 'Réactiver' : 'Suspendre' });
    if (!v) return;
    try { await C.api('POST', `/workspaces/${ws.id}/${suspended ? 'reactivate' : 'suspend'}`, v); C.toast(suspended ? 'Espace réactivé.' : 'Espace suspendu, sessions fermées.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  });
  $('#reinv').addEventListener('click', async () => {
    const v = await C.dialog({ title: 'Nouvelle invitation d’administrateur', fields: [{ name: 'email', label: 'E-mail', type: 'email', required: true, value: ws.invitationAdmin ? ws.invitationAdmin.email : '' }], confirm: 'Créer le lien' });
    if (!v) return;
    try { const r = await C.api('POST', `/workspaces/${ws.id}/admin-invitation`, v); $('#reinvOut').innerHTML = C.onceBox(`Lien d’invitation de ${r.invitation.email}`, r.invitation.lien, `Affiché une seule fois. Valable jusqu’au ${C.fdt(r.invitation.expire)}.`); }
    catch (e) { C.toast(e.message, 'err'); }
  });
  if ($('#exp')) $('#exp').addEventListener('click', async () => {
    try { const r = await C.api('POST', `/workspaces/${ws.id}/export`, {}); C.toast('Export écrit sur le serveur.');
      $('#expOut').innerHTML = `<div class="note note-ok mt-14">${IC.ok}<div><div class="note-t">Export prêt</div><span class="mono t-xs">${esc(r.export.chemin)}</span><br>${C.bytes(r.export.taille)} · sha256 <span class="mono t-xs">${esc(r.export.sha256)}</span></div></div>`;
      ws.dernierExport = { id: r.export.id, fichier: r.export.fichier, sha256: r.export.sha256, taille: r.export.taille, le: new Date().toISOString().replace('T', ' ').slice(0, 19) };
      $('#del').disabled = false; $('#del').removeAttribute('title'); }
    catch (e) { C.toast(e.message, 'err'); }
  });
  if ($('#del')) $('#del').addEventListener('click', async () => {
    const v = await C.dialog({ title: `Supprimer l’espace « ${ws.slug} » ?`, danger: true, typed: ws.slug,
      body: `<div class="note note-danger">${IC.warn}<div>L’espace devient inaccessible et ses ${ws.sessionsActives} session(s) sont fermées. Les données (${C.int(ws.clients)} dossier(s), ${C.int(ws.factures)} facture(s)) restent conservées jusqu’à la purge manuelle, possible après 30 jours. Export utilisé : <span class="mono">${esc(ws.dernierExport.fichier)}</span>.</div></div>`,
      fields: [{ name: 'motif', label: 'Motif', type: 'textarea', required: true }], confirm: 'Supprimer l’espace' });
    if (!v) return;
    try { await C.api('POST', `/workspaces/${ws.id}/delete`, { motif: v.motif, confirmation: ws.slug, exportId: ws.dernierExport.id }); C.toast('Espace supprimé (suppression douce).'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  });
  if ($('#restore')) $('#restore').addEventListener('click', async () => {
    const v = await C.dialog({ title: `Restaurer « ${ws.slug} » ?`, fields: [{ name: 'motif', label: 'Motif', type: 'textarea', required: true }], confirm: 'Restaurer (suspendu)' });
    if (!v) return;
    try { await C.api('POST', `/workspaces/${ws.id}/restore`, v); C.toast('Espace restauré, suspendu.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  });
}, 90);
});
