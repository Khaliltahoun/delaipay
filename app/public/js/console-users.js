'use strict';
/* Console — onglet « Utilisateurs » de la fiche d'un espace. */
(window.DPC_EXT = window.DPC_EXT || []).push(function (C) {
const { $$, esc, IC } = C;
const ROLES = { admin: 'Administrateur', collaborateur: 'Comptable', lecture: 'Lecture seule' };
C.ROLES = ROLES;
C.wsTab('users', 'Utilisateurs', async (el, ws, reload) => {
  const d = await C.api('GET', `/workspaces/${ws.id}/users`);
  const admins = d.rows.filter(u => u.role === 'admin' && u.actif).length;
  el.innerHTML = `<p class="t-sm muted m-0 mb-14">Actions inscrites au journal plateforme et au journal de l’espace. Le dernier administrateur actif ne peut être ni rétrogradé ni désactivé.</p>`
    + C.table(['Utilisateur', 'Rôle', 'Statut', 'Créé le', 'Dernière connexion', { label: 'Appareils', num: true }, { label: 'Sessions', num: true }, { html: '<span class="sr-only">Actions</span>' }],
      d.rows.map(u => `<tr>
        <td class="first"><b>${esc(u.nom || '—')}</b> <span class="muted t-xs">${esc(u.email)}</span></td>
        <td data-l="Rôle">${esc(ROLES[u.role] || u.role)}</td>
        <td data-l="Statut">${u.actif ? '<span class="pill pill-sm pill-ok">Actif</span>' : '<span class="pill pill-sm pill-locked">Désactivé</span>'}</td>
        <td data-l="Créé" class="mono">${C.fd(u.created_at)}</td><td data-l="Connexion">${C.ago(u.derniere_connexion)}</td>
        <td class="num" data-l="Appareils">${u.appareils}</td><td class="num" data-l="Sessions">${u.sessionsActives}</td>
        <td class="col-act"><div class="row-12" style="gap:4px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-xs" data-act="view" data-u="${esc(u.id)}">Sessions et appareils</button>
          <button class="btn btn-ghost btn-xs" data-act="role" data-u="${esc(u.id)}">Rôle…</button>
          <button class="btn btn-ghost btn-xs" data-act="${u.actif ? 'off' : 'on'}" data-u="${esc(u.id)}">${u.actif ? 'Désactiver…' : 'Réactiver'}</button>
          <button class="btn btn-ghost btn-xs" data-act="logout" data-u="${esc(u.id)}" ${u.sessionsActives ? '' : 'disabled'}>Déconnecter</button>
          <button class="btn btn-ghost btn-xs" data-act="reset" data-u="${esc(u.id)}" ${u.actif ? '' : 'disabled'}>Lien de réinitialisation</button>
          <button class="btn btn-ghost btn-xs" data-act="devices" data-u="${esc(u.id)}" ${u.appareils ? '' : 'disabled'}>Révoquer les appareils…</button>
        </div></td></tr>`), { empty: 'Aucun utilisateur : le premier administrateur n’a pas encore accepté son invitation.' })
    + (d.invitations.length ? `<h3 class="sub-h">Invitations</h3>` + C.table(['E-mail', 'Rôle', 'Statut', 'Créée le', 'Expire le'], d.invitations.map(i => `<tr>
        <td class="first">${esc(i.email)}</td><td data-l="Rôle">${esc(ROLES[i.role] || i.role)}</td><td data-l="Statut">${esc({ en_attente: 'En attente', acceptee: 'Acceptée', revoquee: 'Révoquée', expiree: 'Expirée' }[i.statut] || i.statut)}</td>
        <td data-l="Créée" class="mono">${C.fd(i.created_at)}</td><td data-l="Expire" class="mono">${C.fdt(i.expires_at)}</td></tr>`)) : '')
    + '<div id="usrOut"></div>';
  const byId = id => d.rows.find(u => u.id === id);
  $$('[data-act]', el).forEach(b => b.addEventListener('click', async () => {
    const u = byId(b.dataset.u), who = `${u.nom || u.email} (${u.email})`;
    const call = async (method, path, body, ok) => { try { const r = await C.api(method, path, body); C.toast(ok(r)); reload(); return r; } catch (e) { C.toast(e.message, 'err'); return null; } };
    const base = `/workspaces/${ws.id}/users/${u.id}`;
    if (b.dataset.act === 'view') {
      const [ses, dev] = await Promise.all([C.api('GET', `/sessions?user=${u.id}&toutes=1&limit=100`), C.api('GET', `/devices?user=${u.id}`)]);
      const line = s => `<tr><td class="first">${esc([s.navigateur, s.os, s.modele].filter(Boolean).join(' · ') || '—')}</td><td class="mono" data-l="IP">${esc(s.ipDerniere || s.derniereIp || '—')}</td><td data-l="Pays">${esc(s.pays || '—')}</td><td data-l="Vu">${C.ago(s.vu || s.lastSeen)}</td><td data-l="Statut">${esc(s.statutLabel || (s.active ? 'Active' : (s.motifFin || 'Terminée')))}</td></tr>`;
      await C.dialog({ title: `Sessions et appareils — ${who}`, wide: true, cancel: 'Fermer', confirm: 'OK',
        body: `<h4 class="sub-h">Appareils (${dev.rows.length})</h4>${C.table(['Appareil', 'Dernière IP', 'Pays', 'Dernière utilisation', 'Statut'], dev.rows.map(line), { empty: 'Aucun appareil.' })}
          <h4 class="sub-h">Sessions (100 dernières)</h4>${C.table(['Appareil', 'IP', 'Pays', 'Dernière activité', 'Statut'], ses.rows.map(line), { empty: 'Aucune session.' })}` });
      return;
    }
    if (b.dataset.act === 'role') {
      const v = await C.dialog({ title: `Rôle de ${who}`, body: u.role === 'admin' && admins <= 1 ? `<div class="note note-warn">${IC.warn}<div>Dernier administrateur actif : il ne peut pas être rétrogradé.</div></div>` : '',
        fields: [{ name: 'role', label: 'Rôle', type: 'select', value: u.role, options: Object.entries(ROLES).map(([value, label]) => ({ value, label })) }], confirm: 'Changer le rôle' });
      if (v && v.role !== u.role) await call('PATCH', base, { role: v.role }, () => 'Rôle modifié.');
    } else if (b.dataset.act === 'off') {
      const v = await C.dialog({ title: `Désactiver ${who} ?`, danger: true, body: `<p class="t-sm">Accès coupé immédiatement : ${u.sessionsActives} session(s) fermée(s). Les données et le journal restent intacts.</p>`, confirm: 'Désactiver' });
      if (v) await call('PATCH', base, { actif: false }, () => 'Utilisateur désactivé, sessions fermées.');
    } else if (b.dataset.act === 'on') {
      await call('PATCH', base, { actif: true }, () => 'Utilisateur réactivé.');
    } else if (b.dataset.act === 'logout') {
      const v = await C.dialog({ title: `Déconnecter ${who} ?`, body: `<p class="t-sm">${u.sessionsActives} session(s) active(s) seront fermées sur tous ses appareils. Il pourra se reconnecter.</p>`, confirm: 'Déconnecter' });
      if (v) await call('POST', base + '/logout', {}, r => `${r.sessionsFermees} session(s) fermée(s).`);
    } else if (b.dataset.act === 'reset') {
      const v = await C.dialog({ title: `Lien de réinitialisation pour ${who} ?`, body: '<p class="t-sm">Un lien à usage unique, valable 24 heures, sera affiché <b>une seule fois</b>. Les liens précédents sont annulés. À l’utilisation, toutes ses sessions seront fermées.</p>', confirm: 'Créer le lien' });
      if (!v) return;
      try { const r = await C.api('POST', base + '/reset-link', {}); C.showOnce('Lien de réinitialisation', C.onceBox(`Lien pour ${r.email}`, r.lien, `Valable jusqu’au ${C.fdt(r.expire)}. Transmettez-le par un canal sûr.`)); }
      catch (e) { C.toast(e.message, 'err'); }
    } else if (b.dataset.act === 'devices') {
      const v = await C.dialog({ title: `Révoquer les appareils de ${who} ?`, danger: true, body: `<p class="t-sm">${u.appareils} appareil(s) révoqué(s) et leurs sessions fermées. Si l’espace exige des appareils approuvés, chaque nouvel appareil devra être approuvé.</p>`, confirm: 'Révoquer' });
      if (v) await call('POST', base + '/revoke-devices', {}, r => `${r.appareils} appareil(s) révoqué(s), ${r.sessions} session(s) fermée(s).`);
    }
  }));
}, 30);
});
