'use strict';
/* Console — sessions et appareils (vue globale, par espace, par utilisateur), politique d'accès d'un espace, IP bloquées. */
(window.DPC_EXT = window.DPC_EXT || []).push(function (C) {
const { $, $$, esc, IC } = C;
const DEV = { connu: ['Connu', 'pill-locked'], en_attente: ['En attente', 'pill-warn'], approuve: ['Approuvé', 'pill-ok'], refuse: ['Refusé', 'pill-late'], revoque: ['Révoqué', 'pill-locked'] };
const devPill = s => `<span class="pill pill-sm ${(DEV[s] || [])[1] || ''}">${esc((DEV[s] || [s])[0])}</span>`;
const devLabel = d => [d.navigateur, d.os].filter(Boolean).join(' · ') || '—';
const END = { deconnexion: 'Déconnexion', deconnexion_forcee: 'Fermée par un administrateur', espace_suspendu: 'Espace suspendu', espace_supprime: 'Espace supprimé',
  appareil_revoque: 'Appareil révoqué', compte_desactive: 'Compte désactivé', mot_de_passe_reinitialise: 'Mot de passe réinitialisé', ip_non_autorisee: 'IP non autorisée',
  ip_bloquee: 'IP bloquée', appareil_en_attente: 'Appareil non approuvé', appareil_expire: 'Approbation expirée', fin_support: 'Fin de l’accès d’assistance' };

function sessionsTable(rows, { showWs = true } = {}) {
  return C.table([...(showWs ? ['Espace'] : []), 'Utilisateur', 'Appareil', 'Modèle', 'IP', 'Pays', 'Ouverte', 'Dernière activité', 'Statut', { html: '<span class="sr-only">Actions</span>' }],
    rows.map(s => `<tr>${showWs ? `<td class="first"><a class="rowlink" href="#/workspace/${esc(s.espace.id)}/securite">${esc(s.espace.slug || '—')}</a></td>` : ''}
      <td class="${showWs ? '' : 'first'}" data-l="Utilisateur">${esc(s.utilisateur.nom || s.utilisateur.email || '—')}${s.type === 'support' ? ' <span class="pill pill-sm pill-warn">assistance</span>' : ''} <span class="muted t-xs">${esc(s.utilisateur.email || '')}</span></td>
      <td data-l="Appareil">${esc(devLabel(s))} <span class="muted t-xs">${esc(s.typeAppareil || '')}</span></td><td data-l="Modèle">${esc(s.modele || '—')}</td>
      <td class="mono" data-l="IP">${esc(s.ipDerniere || s.ip || '—')}</td><td data-l="Pays">${esc(s.pays || '—')}</td>
      <td class="mono" data-l="Ouverte">${C.fdt(s.debut)}</td><td data-l="Vue">${C.ago(s.vu)}</td>
      <td data-l="Statut">${s.active ? '<span class="pill pill-sm pill-ok">Active</span>' : `<span class="muted t-xs">${esc(END[s.motifFin] || s.motifFin || 'Expirée')}</span>`}</td>
      <td class="col-act">${s.active ? `<button class="btn btn-ghost btn-xs" data-revs="${esc(s.id)}">Fermer</button>` : ''}</td></tr>`),
    { empty: 'Aucune session.', compact: !showWs });
}
function devicesTable(rows, { showWs = true } = {}) {
  return C.table([...(showWs ? ['Espace'] : []), 'Utilisateur', 'Appareil', 'Modèle', 'Statut', 'Première IP', 'Dernière IP', 'Pays', 'Vu la 1re fois', 'Dernière utilisation', { html: '<span class="sr-only">Actions</span>' }],
    rows.map(d => `<tr>${showWs ? `<td class="first"><a class="rowlink" href="#/workspace/${esc(d.espace.id)}/securite">${esc(d.espace.slug || '—')}</a></td>` : ''}
      <td class="${showWs ? '' : 'first'}" data-l="Utilisateur">${esc((d.utilisateur && (d.utilisateur.nom || d.utilisateur.email)) || '—')} <span class="muted t-xs">${esc((d.utilisateur && d.utilisateur.email) || '')}</span></td>
      <td data-l="Appareil">${esc(devLabel(d))} <span class="muted t-xs">${esc(d.type || '')}</span></td><td data-l="Modèle">${esc(d.modele || '—')}</td>
      <td data-l="Statut">${devPill(d.statut)}${d.expireLe ? ` <span class="muted t-xs">→ ${C.fdt(d.expireLe)}</span>` : ''}</td>
      <td class="mono" data-l="1re IP">${esc(d.premiereIp || '—')}</td><td class="mono" data-l="IP">${esc(d.derniereIp || '—')}</td><td data-l="Pays">${esc(d.pays || '—')}</td>
      <td class="mono" data-l="Depuis">${C.fdt(d.firstSeen)}</td><td data-l="Vu">${C.ago(d.lastSeen)}</td>
      <td class="col-act"><div class="row-12" style="gap:4px">${d.statut !== 'approuve' && d.statut !== 'revoque' ? `<button class="btn btn-primary btn-xs" data-dev="approve" data-id="${esc(d.id)}">Approuver</button>` : ''}
        ${d.statut === 'en_attente' ? `<button class="btn btn-ghost btn-xs" data-dev="refuse" data-id="${esc(d.id)}">Refuser</button>` : ''}
        ${['approuve', 'connu'].includes(d.statut) ? `<button class="btn btn-ghost btn-xs" data-dev="revoke" data-id="${esc(d.id)}">Révoquer</button>` : ''}</div></td></tr>`),
    { empty: 'Aucun appareil.', compact: !showWs });
}
function wireRows(el, reload) {
  $$('[data-revs]', el).forEach(b => b.addEventListener('click', async () => {
    const v = await C.dialog({ title: 'Fermer cette session ?', body: '<p class="t-sm">L’utilisateur devra se reconnecter. Inscrit aux journaux de la plateforme et de l’espace.</p>', confirm: 'Fermer la session' });
    if (!v) return;
    try { await C.api('POST', `/sessions/${b.dataset.revs}/revoke`, {}); C.toast('Session fermée.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  }));
  $$('[data-dev]', el).forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.dev, L = { approve: 'Approuver', refuse: 'Refuser', revoke: 'Révoquer' }[act];
    const v = await C.dialog({ title: `${L} cet appareil ?`, danger: act !== 'approve', body: act === 'revoke' ? '<p class="t-sm">Ses sessions sont fermées immédiatement.</p>' : '', confirm: L });
    if (!v) return;
    try { await C.api('POST', `/devices/${b.dataset.id}/${act}`, {}); C.toast('Décision enregistrée.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  }));
}

/* ------------------------------------------------------------------ vue globale */
let gState = { tab: 'sessions', toutes: false, statut: '' };
C.views.sessions = async (el, params = []) => {
  if (params[0]) { gState.tab = params[0] === 'devices' ? 'devices' : 'sessions'; gState.statut = params[1] || ''; }
  const [ses, dev] = await Promise.all([C.api('GET', `/sessions?limit=500${gState.toutes ? '&toutes=1' : ''}`), C.api('GET', `/devices?limit=500${gState.statut ? '&statut=' + gState.statut : ''}`)]);
  const pending = dev.rows.filter(d => d.statut === 'en_attente').length;
  el.innerHTML = C.pageHead('Sessions et appareils', `Tous les espaces. Modèle d’appareil : uniquement s’il est transmis par le navigateur (indice client), jamais deviné. Pays : ${ses.geoip ? 'base GeoIP locale' : '« — » (aucune base GeoIP locale configurée)'}.`)
    + `<div class="tabs" role="tablist"><button class="tab" role="tab" data-t="sessions" aria-selected="${gState.tab === 'sessions'}">Sessions (${ses.rows.length})</button>
       <button class="tab" role="tab" data-t="devices" aria-selected="${gState.tab === 'devices'}">Appareils${pending ? ` · ${pending} en attente` : ''}</button></div>
    <div class="cons-toolbar">${gState.tab === 'sessions'
      ? `<label class="check"><input type="checkbox" id="gAll" ${gState.toutes ? 'checked' : ''}> <span>Inclure les sessions terminées</span></label>`
      : `<select class="input-fld" id="gSt"><option value="">Tous les statuts</option>${Object.entries(DEV).map(([k, [l]]) => `<option value="${k}" ${gState.statut === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</div>
    <div id="gBody">${gState.tab === 'sessions' ? sessionsTable(ses.rows) : devicesTable(dev.rows)}</div>`;
  $$('[data-t]', el).forEach(b => b.addEventListener('click', () => { gState.tab = b.dataset.t; C.render(); }));
  const all = $('#gAll'); if (all) all.addEventListener('change', e => { gState.toutes = e.target.checked; C.render(); });
  const st = $('#gSt'); if (st) st.addEventListener('change', e => { gState.statut = e.target.value; C.render(); });
  wireRows(el, () => C.render());
};

/* ------------------------------------------------------------------ onglet « Sécurité » d'un espace */
C.wsTab('securite', 'Sécurité et appareils', async (el, ws, reload) => {
  const d = await C.api('GET', `/workspaces/${ws.id}/security`);
  const p = d.politique;
  const listEditor = (id, list) => `<div class="ip-list" id="${id}">${(list.length ? list : [{ cidr: '', label: '' }]).map(e => `<div class="ip-row"><input class="input-fld mono" placeholder="203.0.113.0/24" value="${esc(e.cidr || '')}" aria-label="Adresse ou plage"><input class="input-fld" placeholder="Libellé" value="${esc(e.label || '')}" aria-label="Libellé"><button class="btn btn-quiet btn-sm" type="button" data-rm title="Retirer">×</button></div>`).join('')}</div>
    <button class="btn btn-quiet btn-sm mt-8" type="button" data-add="${id}">${IC.plus}Ajouter</button>`;
  el.innerHTML = `<div class="cons-grid"><div class="card"><div class="card-h"><h3>Politique d’accès — <span class="muted">${esc(d.mode)}</span></h3></div><div class="card-b">
      <label class="check"><input type="checkbox" id="p_dev" ${p.appareils ? 'checked' : ''}> <span><b>Appareils approuvés</b> : tout appareil inconnu reste « en attente » jusqu’à approbation.</span></label>
      <label class="check mt-8 ${p.appareils ? 'hidden' : ''}" id="p_known_w"><input type="checkbox" id="p_known" checked> <span>À l’activation, approuver les appareils déjà connus des utilisateurs actifs (évite de bloquer l’équipe)</span></label>
      <div class="fld mt-12"><label class="fld-lbl" for="p_days">Durée d’une approbation (jours) <span class="muted t-xs">(vide = sans expiration)</span></label><input class="input-fld" id="p_days" type="number" min="1" max="730" value="${p.dureeApprobationJours || ''}" style="max-width:160px"></div>
      <label class="check mt-12"><input type="checkbox" id="p_ip" ${p.ipAutorisees ? 'checked' : ''}> <span><b>Liste d’IP autorisées</b> (connexion et chaque requête)</span></label>
      <div class="mt-8">${listEditor('p_allow', p.listeIp)}</div>
      <div class="fld-lbl mt-14">IP bloquées pour cet espace</div>${listEditor('p_block', p.ipBloquees)}
      <p class="t-xs muted mt-14 m-0">Votre IP (console) : <span class="mono">${esc(d.ipConsole || '—')}</span> — la console n’est pas soumise à la politique de l’espace. IP bloquées pour toute la plateforme : ${d.ipBloqueesGlobales.length} (Réglages).</p>
      <div id="p_warn"></div>
      <div class="row-12 mt-14"><button class="btn btn-primary" id="p_save">Enregistrer la politique</button></div>
    </div></div>
    <div class="card"><div class="card-h"><h3>Rappel des règles</h3></div><div class="card-b t-sm">
      <p class="m-0">• Un appareil est identifié par un jeton aléatoire (cookie httpOnly, haché en base, lié à l’utilisateur et à l’espace) — jamais par son IP : un appareil approuvé reste approuvé si l’IP change.</p>
      <p>• Politique vérifiée à la connexion <b>et</b> à chaque requête ; révoquer un appareil ferme ses sessions.</p>
      <p>• Les deux modes se combinent. L’administrateur de l’espace peut aussi approuver les appareils dans Paramètres → Sécurité.</p>
      <p class="m-0">• Chaque changement est inscrit au journal de la plateforme et à celui de l’espace.</p></div></div>
    <div class="card span-2"><div class="card-h"><h3>Appareils (${d.appareils.length})</h3></div><div class="card-b" style="padding:0">${devicesTable(d.appareils, { showWs: false })}</div></div>
    <div class="card span-2"><div class="card-h"><h3>Sessions actives (${d.sessions.length})</h3></div><div class="card-b" style="padding:0">${sessionsTable(d.sessions, { showWs: false })}</div></div></div>`;
  $('#p_dev').addEventListener('change', e => $('#p_known_w').classList.toggle('hidden', !e.target.checked || p.appareils));
  const wireRm = () => $$('[data-rm]', el).forEach(b => { b.onclick = () => { const l = b.closest('.ip-list'); if (l.children.length > 1) b.closest('.ip-row').remove(); else b.closest('.ip-row').querySelectorAll('input').forEach(i => { i.value = ''; }); }; });
  $$('[data-add]', el).forEach(b => b.addEventListener('click', () => { const l = $('#' + b.dataset.add); const r = l.querySelector('.ip-row').cloneNode(true); r.querySelectorAll('input').forEach(i => { i.value = ''; }); l.appendChild(r); wireRm(); }));
  wireRm();
  const readList = id => [...$('#' + id).querySelectorAll('.ip-row')].map(r => { const [c, l] = r.querySelectorAll('input'); return { cidr: c.value.trim(), label: l.value.trim() }; }).filter(e => e.cidr);
  $('#p_save').addEventListener('click', async () => {
    const body = { appareils: $('#p_dev').checked, approuverAppareilsConnus: $('#p_known').checked, dureeApprobationJours: $('#p_days').value || null,
      ipAutorisees: $('#p_ip').checked, listeIp: readList('p_allow'), ipBloquees: readList('p_block') };
    // CONS-IP : aperçu AVANT d'enregistrer (plages validées par le serveur), confirmation saisie si quelqu'un serait coupé.
    let pv;
    try { pv = await C.api('POST', `/workspaces/${ws.id}/security/preview`, body); } catch (e) { $('#p_warn').innerHTML = `<div class="note note-danger mt-14">${IC.warn}<div>${esc(e.message)}</div></div>`; return; }
    const RAISON = { ip_non_autorisee: 'hors liste autorisée', ip_bloquee: 'IP bloquée' };
    const rows = [...pv.sessions.map(x => `<li><b>${esc(x.nom || x.email || '—')}</b> <span class="muted">${esc(x.email || '')}</span> — session active, dernière IP <span class="mono">${esc(x.ip || '—')}</span> (${esc(RAISON[x.raison] || x.raison)})</li>`),
      ...pv.utilisateurs.filter(u => !pv.sessions.some(x => x.email === u.email)).map(u => `<li><b>${esc(u.nom || u.email)}</b> <span class="muted">${esc(u.email)}</span> — dernière IP <span class="mono">${esc(u.ip)}</span> vue ${C.ago(u.vu)} (${esc(RAISON[u.raison] || u.raison)})</li>`)];
    const adm = pv.dernierAccesAdmin;
    const admLine = adm ? `<p class="t-sm">Dernier accès d’un administrateur : ${esc(adm.email)} depuis <span class="mono">${esc(adm.ip)}</span> — ${adm.horsListe ? '<b class="c-late">en dehors de la politique</b>' : 'autorisé'}.</p>` : '';
    const v = await C.dialog({ title: pv.coupure ? `Cette politique couperait ${pv.sessions.length} session(s) et ${pv.utilisateurs.length} utilisateur(s)` : 'Enregistrer la politique d’accès ?', danger: pv.coupure, wide: true,
      typed: pv.coupure ? pv.slug : null, confirm: pv.coupure ? 'Couper ces accès et enregistrer' : 'Enregistrer',
      body: pv.coupure ? `<div class="note note-danger">${IC.warn}<div><div class="note-t">Accès coupés dès leur prochaine action</div><ul>${rows.join('')}</ul></div></div>${admLine}${pv.aucunAdminDansLaListe ? '<p class="t-sm c-late">Aucun administrateur de l’espace ne s’est connecté récemment depuis une adresse autorisée : l’espace risque de ne plus pouvoir s’administrer lui-même.</p>' : ''}`
        : `<p class="t-sm">Aucune session active ni aucun utilisateur ne serait coupé d’après les dernières IP vues.</p>${admLine}` });
    if (!v) return;
    body.confirmation = pv.coupure ? pv.slug : undefined;
    try {
      const r = await C.api('PUT', `/workspaces/${ws.id}/security/policy`, body);
      if (r.avertissements.length) { $('#p_warn').innerHTML = `<div class="note note-warn mt-14">${IC.warn}<div><div class="note-t">Enregistrée — à vérifier</div>${r.avertissements.map(esc).join('<br>')}</div></div>`; C.toast('Politique enregistrée avec avertissements.', 'warn'); }
      else { C.toast(`Politique enregistrée${r.approuves ? ` · ${r.approuves} appareil(s) approuvé(s)` : ''}.`); reload(); }
    } catch (e) { C.toast(e.message, 'err'); }
  });
  wireRows(el, reload);
}, 50);

/* ------------------------------------------------------------------ réglages : IP bloquées globales + liste d'IP de la console */
C.settingsCard(20, async (box, reload) => {
  const d = await C.api('GET', '/ip-blocklist');
  box.innerHTML = `<div class="card-h"><h3>IP bloquées — toute la plateforme</h3></div><div class="card-b">
    <p class="t-sm m-0 mb-14">Refusées à la connexion et à chaque requête, dans tous les espaces (la console n’est pas concernée).</p>
    <div class="ip-list" id="gb">${(d.rows.length ? d.rows : [{ cidr: '', label: '' }]).map(e => `<div class="ip-row"><input class="input-fld mono" placeholder="203.0.113.0/24" value="${esc(e.cidr || '')}" aria-label="Adresse ou plage"><input class="input-fld" placeholder="Libellé" value="${esc(e.label || '')}" aria-label="Libellé"><button class="btn btn-quiet btn-sm" type="button" data-rm>×</button></div>`).join('')}</div>
    <div class="row-12 mt-8"><button class="btn btn-quiet btn-sm" id="gbAdd">${IC.plus}Ajouter</button><button class="btn btn-primary btn-sm" id="gbSave">Enregistrer</button></div></div>`;
  const wireRm = () => $$('[data-rm]', box).forEach(b => { b.onclick = () => { const l = b.closest('.ip-list'); if (l.children.length > 1) b.closest('.ip-row').remove(); else b.closest('.ip-row').querySelectorAll('input').forEach(i => { i.value = ''; }); }; });
  wireRm();
  $('#gbAdd', box).addEventListener('click', () => { const l = $('#gb', box); const r = l.querySelector('.ip-row').cloneNode(true); r.querySelectorAll('input').forEach(i => { i.value = ''; }); l.appendChild(r); wireRm(); });
  $('#gbSave', box).addEventListener('click', async () => {
    const rows = [...$('#gb', box).querySelectorAll('.ip-row')].map(r => { const [c, l] = r.querySelectorAll('input'); return { cidr: c.value.trim(), label: l.value.trim() }; }).filter(e => e.cidr);
    let pv; try { pv = await C.api('POST', '/ip-blocklist/preview', { rows }); } catch (e) { return C.toast(e.message, 'err'); }
    if (pv.coupure) {
      const v = await C.dialog({ title: `Couper ${pv.sessions.length} session(s) active(s) ?`, danger: true, typed: 'BLOQUER', wide: true, confirm: 'Bloquer et couper ces sessions',
        body: `<div class="note note-danger">${IC.warn}<div><ul>${pv.sessions.map(x => `<li><b>${esc(x.slug || '—')}</b> · ${esc(x.email || 'assistance')} — dernière IP <span class="mono">${esc(x.ip)}</span></li>`).join('')}</ul></div></div>` });
      if (!v) return;
    }
    try { await C.api('PUT', '/ip-blocklist', { rows, confirmation: pv.coupure ? 'BLOQUER' : undefined }); C.toast('Liste enregistrée.'); reload(); } catch (e) { C.toast(e.message, 'err'); }
  });
});
C.settingsCard(30, async (box) => {
  const d = await C.api('GET', '/console-allowlist');
  box.innerHTML = `<div class="card-h"><h3>Accès à la console par adresse IP</h3></div><div class="card-b">
    ${d.rows.length ? `<p class="t-sm m-0 mb-14">La console n’est accessible que depuis :</p><ul class="t-sm mono" style="margin:0 0 12px 18px;padding:0">${d.rows.map(r => `<li>${esc(r.cidr)} <span class="muted">${esc(r.label || '')} · ${esc(r.source)}</span></li>`).join('')}</ul>`
      : '<p class="t-sm m-0 mb-14">Aucune restriction : la console est accessible depuis toute adresse (double authentification exigée).</p>'}
    <p class="t-xs muted m-0">Géré uniquement en ligne de commande sur le serveur (<span class="mono">npm run platform:admin -- allowlist add --cidr …</span>) ou par la variable <span class="mono">PLATFORM_ALLOWED_IPS</span> — jamais depuis la console, pour éviter de s’en exclure. Votre IP : <span class="mono">${esc(d.ip || '—')}</span>.</p></div>`;
});
});
